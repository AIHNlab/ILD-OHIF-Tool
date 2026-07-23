import os, glob, shutil, tempfile, torch
from monailabel.interfaces.tasks.infer_v2 import InferType
from monailabel.tasks.infer.basic_infer import BasicInferTask

class NNUNet(BasicInferTask):
    def __init__(self, model_folder, labels, label_colors=None, folds=(0,),
                 checkpoint="checkpoint_final.pth", **kwargs):
        super().__init__(path=None, network=None, type="segmentation",
                         labels=labels, dimension=3,
                         description="nnU-Net v2 auto-segmentation", **kwargs)
        self._label_colors = label_colors or {}

        from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
        self.predictor = nnUNetPredictor(
            tile_step_size=0.5, use_gaussian=True, use_mirroring=True,
            device=torch.device("cuda", 0))
        self.predictor.initialize_from_trained_model_folder(
            model_folder, use_folds=folds, checkpoint_name=checkpoint)

    def is_valid(self) -> bool:
        return True

    # required abstract stubs — unused because we override __call__
    def pre_transforms(self, data=None):
        return []

    def post_transforms(self, data=None):
        return []

    def __call__(self, request, callbacks=None):
        import numpy as np, nibabel as nib, SimpleITK as sitk, logging
        log = logging.getLogger(__name__)
        image_path = request.get("image")
        in_dir, out_dir = tempfile.mkdtemp(), tempfile.mkdtemp()
        shutil.copy(image_path, os.path.join(in_dir, "case_0000.nii.gz"))
        self.predictor.predict_from_files(in_dir, out_dir,
                                          save_probabilities=False, overwrite=True)
        result = glob.glob(os.path.join(out_dir, "*.nii.gz"))[0]

        nii   = nib.load(result)
        arr   = np.asanyarray(nii.dataobj).astype(np.uint8)
        zooms = nii.header.get_zooms()
        log.info(f"NNUNET unique labels: {np.unique(arr)}")

        # nibabel: (x,y,z), sitk needs (z,y,x)
        arr_zyx = np.ascontiguousarray(arr.transpose(2, 1, 0))
        seg = sitk.GetImageFromArray(arr_zyx)
        seg.SetSpacing((float(zooms[0]), float(zooms[1]), float(zooms[2])))
        seg.SetDirection((1.0,0.0,0.0, 0.0,1.0,0.0, 0.0,0.0,1.0))
        # correct origin for LPS: flip accounts for the negative affine diagonal
        sx, sy, sz = arr.shape  # nibabel shape is (x,y,z)
        ox = float(nii.affine[0,3]) + (sx - 1) * float(nii.affine[0,0]) if nii.affine[0,0] < 0 else float(nii.affine[0,3])
        oy = float(nii.affine[1,3]) + (sy - 1) * float(nii.affine[1,1]) if nii.affine[1,1] < 0 else float(nii.affine[1,3])
        oz = float(nii.affine[2,3])
        seg.SetOrigin((ox, oy, oz))

        fixed = os.path.join(out_dir, "seg.nrrd")
        sitk.WriteImage(seg, fixed, useCompression=False)
        log.info(f"WROTE {fixed} size={os.path.getsize(fixed)}")
        return fixed, {
            "label_names": self.labels,
            "label_colors": self._label_colors,
            "centroids": {},
        }