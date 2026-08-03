import os, glob, shutil, tempfile, torch
from monailabel.interfaces.tasks.infer_v2 import InferType
from monailabel.tasks.infer.basic_infer import BasicInferTask

# extra slices of through-plane context to keep around a drawn ROI's slice,
# since nnU-Net's 3d_fullres inference needs a real 3D volume, not one slice
Z_MARGIN = 32
# floor on the in-plane crop size so a tiny drawn box still gives nnU-Net
# enough context to run its sliding-window inference meaningfully
XY_MIN_SIZE = 96

class NNUNet(BasicInferTask):
    def __init__(self, model_folder, labels, label_colors=None, folds=(0,),
                 checkpoint="checkpoint_final.pth", **kwargs):
        super().__init__(path=None, network=None, type="segmentation",
                         labels=labels, dimension=3,
                         description="nnU-Net v2 auto-segmentation", **kwargs)
        self._label_colors = label_colors or {}

        from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
        device = torch.device("cuda", 0) if torch.cuda.is_available() else torch.device("cpu")
        self.predictor = nnUNetPredictor(
            tile_step_size=0.5, use_gaussian=True, use_mirroring=True,
            device=device)
        self.predictor.initialize_from_trained_model_folder(
            model_folder, use_folds=folds, checkpoint_name=checkpoint)

    def is_valid(self) -> bool:
        return True

    # required abstract stubs — unused because we override __call__
    def pre_transforms(self, data=None):
        return []

    def post_transforms(self, data=None):
        return []

    def _roi_to_bbox(self, roi, shape):
        x0, y0, z0 = roi["start"]
        x1, y1, _ = roi["end"]
        xmin, xmax = sorted((int(x0), int(x1)))
        ymin, ymax = sorted((int(y0), int(y1)))
        z = int(z0)

        # pad in-plane box up to XY_MIN_SIZE, centered on the drawn box
        if xmax - xmin < XY_MIN_SIZE:
            cx = (xmin + xmax) // 2
            xmin, xmax = cx - XY_MIN_SIZE // 2, cx + XY_MIN_SIZE // 2
        if ymax - ymin < XY_MIN_SIZE:
            cy = (ymin + ymax) // 2
            ymin, ymax = cy - XY_MIN_SIZE // 2, cy + XY_MIN_SIZE // 2

        xmin, xmax = max(0, xmin), min(shape[0], xmax)
        ymin, ymax = max(0, ymin), min(shape[1], ymax)
        zmin, zmax = max(0, z - Z_MARGIN), min(shape[2], z + Z_MARGIN + 1)
        return xmin, xmax, ymin, ymax, zmin, zmax

    def __call__(self, request, callbacks=None):
        import numpy as np, nibabel as nib, SimpleITK as sitk, logging
        log = logging.getLogger(__name__)
        image_path = request.get("image")
        in_dir, out_dir = tempfile.mkdtemp(), tempfile.mkdtemp()

        roi = request.get("roi")
        bbox = None
        orig_nii = None
        if roi:
            orig_nii = nib.load(image_path)
            bbox = self._roi_to_bbox(roi, orig_nii.shape)
            xmin, xmax, ymin, ymax, zmin, zmax = bbox
            log.info(f"NNUNET ROI crop: x[{xmin}:{xmax}] y[{ymin}:{ymax}] z[{zmin}:{zmax}]")

            orig_arr = np.asanyarray(orig_nii.dataobj)
            crop_arr = orig_arr[xmin:xmax, ymin:ymax, zmin:zmax]

            crop_affine = orig_nii.affine.copy()
            crop_affine[:3, 3] += crop_affine[:3, :3] @ np.array([xmin, ymin, zmin])

            crop_nii = nib.Nifti1Image(crop_arr, crop_affine, header=orig_nii.header)
            nib.save(crop_nii, os.path.join(in_dir, "case_0000.nii.gz"))
        else:
            shutil.copy(image_path, os.path.join(in_dir, "case_0000.nii.gz"))

        self.predictor.predict_from_files(in_dir, out_dir,
                                          save_probabilities=False, overwrite=True)
        result = glob.glob(os.path.join(out_dir, "*.nii.gz"))[0]

        if bbox:
            xmin, xmax, ymin, ymax, zmin, zmax = bbox
            pred_nii = nib.load(result)
            pred_arr = np.asanyarray(pred_nii.dataobj).astype(np.uint16)
            nii = orig_nii
            arr = np.zeros(orig_nii.shape, dtype=np.uint16)
            arr[xmin:xmax, ymin:ymax, zmin:zmax] = pred_arr
        else:
            nii   = nib.load(result)
            arr   = np.asanyarray(nii.dataobj).astype(np.uint16)

        log.info(f"NNUNET unique labels: {np.unique(arr)}")

        # nibabel: (x,y,z), sitk needs (z,y,x)
        arr_zyx = np.ascontiguousarray(arr.transpose(2, 1, 0))
        seg = sitk.GetImageFromArray(arr_zyx)
        # copy origin/spacing/direction straight from the source image instead of
        # re-deriving them from the nibabel affine's sign — deriving them by hand
        # requires mirroring the array to match any negated affine axis, which
        # wasn't happening, so the mask landed mirrored/offset from the anatomy
        seg.CopyInformation(sitk.ReadImage(image_path))

        fixed = os.path.join(out_dir, "seg.nrrd")
        sitk.WriteImage(seg, fixed, useCompression=True)
        log.info(f"WROTE {fixed} size={os.path.getsize(fixed)}")
        return fixed, {
            "label_names": self.labels,
            "label_colors": self._label_colors,
            "centroids": {},
        }