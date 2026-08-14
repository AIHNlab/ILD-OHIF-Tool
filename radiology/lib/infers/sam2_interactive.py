import logging
import tempfile
import threading

import numpy as np
from PIL import Image as PILImage

from monailabel.interfaces.tasks.infer_v2 import InferType
from monailabel.tasks.infer.basic_infer import BasicInferTask

logger = logging.getLogger(__name__)

HU_MIN = -1000
HU_MAX = 400
SAM2_SIZE = 512
SAM2_CFG = "configs/sam2.1_hiera_t512.yaml"


def _normalize_ct(volume: np.ndarray) -> np.ndarray:
    volume = np.clip(volume, HU_MIN, HU_MAX).astype(np.float32)
    volume = (volume - HU_MIN) / (HU_MAX - HU_MIN)
    return (volume * 255).astype(np.uint8)


def _resize_to_rgb(imgs: np.ndarray, size: int = SAM2_SIZE) -> np.ndarray:
    """(D, H, W) uint8 -> (D, 3, size, size) float32 in [0, 1]."""
    d = imgs.shape[0]
    out = np.zeros((d, 3, size, size), dtype=np.float32)
    for z in range(d):
        img = PILImage.fromarray(imgs[z]).resize((size, size), PILImage.BILINEAR)
        arr = np.array(img, dtype=np.float32) / 255.0
        out[z] = np.stack([arr, arr, arr], axis=0)
    return out


def _collect_masks(out_mask_logits, h: int, w: int) -> np.ndarray:
    combined = np.zeros((h, w), dtype=np.uint8)
    for obj_mask in out_mask_logits:
        mask = (obj_mask > 0).cpu().numpy().squeeze()
        if mask.ndim == 0:
            continue
        m = PILImage.fromarray(mask.astype(np.uint8) * 255).resize((w, h), PILImage.NEAREST)
        combined = np.maximum(combined, (np.array(m) > 127).astype(np.uint8))
    return combined


def _scale_xy(x: float, y: float, w: int, h: int) -> tuple:
    return x * SAM2_SIZE / w, y * SAM2_SIZE / h


MAX_PROMPT_POINTS = 40


def _polygon_interior_points(vertices, w: int, h: int, max_points: int = MAX_PROMPT_POINTS) -> np.ndarray:
    """Freehand ROI vertices (index-space, on one slice) -> point prompts sampled
    from inside the drawn polygon, fed to add_new_points_or_box (not a mask prompt
    via add_new_mask - point prompts are what this model was validated against)."""
    from PIL import ImageDraw

    scaled = [_scale_xy(x, y, w, h) for x, y in vertices]
    mask_img = PILImage.new("L", (SAM2_SIZE, SAM2_SIZE), 0)
    ImageDraw.Draw(mask_img).polygon(scaled, outline=1, fill=1)
    ys, xs = np.where(np.array(mask_img) > 0)
    pts = np.stack([xs, ys], axis=1).astype(np.float32)
    if len(pts) > max_points:
        idx = np.random.choice(len(pts), max_points, replace=False)
        pts = pts[idx]
    return pts


class SAM2InteractiveInferTask(BasicInferTask):
    """
    Interactive 3D segmentation using a fine-tuned SAM2 model.

    Accepts one of three prompt types drawn by the user in OHIF on a single
    "key" slice, then propagates the resulting mask forward and backward
    through the volume:
      - foreground/background click points
      - a rectangle ROI (start/end corners, same shape nnU-Net's ROI crop uses)
      - a freehand polygon (sampled into interior point prompts)

    SAM2 only ever produces one binary object mask per run, but the model may
    be configured with several labels (e.g. the 8 ILD patterns) - the request's
    "label" field picks which one this run's mask should be written as.
    """

    def __init__(self, checkpoint_path: str, labels, label_colors=None, description: str = ""):
        super().__init__(
            path=checkpoint_path,
            network=None,
            type=InferType.DEEPGROW,
            labels=labels,
            dimension=3,
            description=description or "SAM2 interactive segmentation",
        )
        self._checkpoint_path = checkpoint_path
        self._label_colors = label_colors or {}
        self._predictor = None
        self._lock = threading.Lock()

    def is_valid(self) -> bool:
        return True

    def pre_transforms(self, data=None):
        return []

    def post_transforms(self, data=None):
        return []

    def _get_predictor(self, device: str):
        if self._predictor is None:
            with self._lock:
                if self._predictor is None:
                    import torch

                    import sam2  # noqa: F401  (triggers Hydra config-module registration)
                    from sam2.build_sam import build_sam2_video_predictor_npz

                    logger.info(f"Loading SAM2 checkpoint: {self._checkpoint_path}")
                    self._predictor = build_sam2_video_predictor_npz(
                        SAM2_CFG,
                        self._checkpoint_path,
                        device=torch.device(device),
                    )
        return self._predictor

    def _propagate(self, predictor, imgs_tensor, key_slice, add_prompt, d, h, w):
        pred_masks = np.zeros((d, h, w), dtype=np.uint8)

        for reverse in (False, True):
            state = predictor.init_state(imgs_tensor, video_height=SAM2_SIZE, video_width=SAM2_SIZE)
            add_prompt(predictor, state, key_slice)
            for fi, _, logits in predictor.propagate_in_video(state, start_frame_idx=key_slice, reverse=reverse):
                pred_masks[fi] = _collect_masks(logits, h, w)
            predictor.reset_state(state)

        return pred_masks

    def __call__(self, request, callbacks=None):
        import SimpleITK as sitk
        import torch

        image_path = request.get("image")
        device = request.get("device", "cuda")
        foreground = request.get("foreground", [])  # [[x, y, z], ...]
        background = request.get("background", [])  # [[x, y, z], ...]
        roi = request.get("roi")  # {"start": [xmin, ymin, z], "end": [xmax, ymax, z]}
        mask_polygon = request.get("mask_polygon")  # [[x, y], ...]
        roi_slice = request.get("roi_slice")
        label_value = self.labels.get(request.get("label"), 1)

        sitk_img = sitk.ReadImage(image_path)
        img_np = sitk.GetArrayFromImage(sitk_img).astype(np.float32)  # (D, H, W)
        d, h, w = img_np.shape

        imgs_rgb = _resize_to_rgb(_normalize_ct(img_np))
        imgs_tensor = torch.from_numpy(imgs_rgb).float()

        predictor = self._get_predictor(device)
        pred_masks = np.zeros((d, h, w), dtype=np.uint8)

        with torch.inference_mode():
            if mask_polygon:
                key_slice = int(roi_slice)
                pts = _polygon_interior_points(mask_polygon, w, h)
                lbs = np.ones(len(pts), dtype=np.int32)

                def add_prompt(predictor, state, frame_idx):
                    predictor.add_new_points_or_box(
                        inference_state=state, frame_idx=frame_idx, obj_id=1, points=pts, labels=lbs
                    )

                pred_masks = self._propagate(predictor, imgs_tensor, key_slice, add_prompt, d, h, w)

            elif roi:
                xmin, ymin, z = roi["start"]
                xmax, ymax, _ = roi["end"]
                key_slice = int(z)
                x0, y0 = _scale_xy(xmin, ymin, w, h)
                x1, y1 = _scale_xy(xmax, ymax, w, h)
                box_scaled = np.array([x0, y0, x1, y1], dtype=np.float32)

                def add_prompt(predictor, state, frame_idx):
                    predictor.add_new_points_or_box(
                        inference_state=state, frame_idx=frame_idx, obj_id=1, box=box_scaled
                    )

                pred_masks = self._propagate(predictor, imgs_tensor, key_slice, add_prompt, d, h, w)

            elif foreground:
                # OHIF sends clicks as [x, y, z] where x=column, y=row, z=slice index
                fg = np.array(foreground)
                key_slice = int(fg[0, 2])
                pts = np.array([_scale_xy(c[0], c[1], w, h) for c in fg], dtype=np.float32)
                lbs = np.ones(len(pts), dtype=np.int32)

                if background:
                    bg = np.array(background)
                    bg_pts = np.array([_scale_xy(c[0], c[1], w, h) for c in bg], dtype=np.float32)
                    pts = np.vstack([pts, bg_pts])
                    lbs = np.concatenate([lbs, np.zeros(len(bg_pts), dtype=np.int32)])

                def add_prompt(predictor, state, frame_idx):
                    predictor.add_new_points_or_box(
                        inference_state=state, frame_idx=frame_idx, obj_id=1, points=pts, labels=lbs
                    )

                pred_masks = self._propagate(predictor, imgs_tensor, key_slice, add_prompt, d, h, w)

            else:
                logger.warning("SAM2 inference called with no prompt (foreground/roi/mask_polygon)")

        if label_value != 1:
            pred_masks = pred_masks * label_value

        ext = request.get("result_extension", ".nrrd")
        if not ext.startswith("."):
            ext = "." + ext
        output_file = tempfile.NamedTemporaryFile(suffix=ext, delete=False).name
        # keep uint8 - the OHIF client reads the NRRD payload as a Uint8Array unconditionally
        pred_sitk = sitk.GetImageFromArray(pred_masks)
        pred_sitk.CopyInformation(sitk_img)
        sitk.WriteImage(pred_sitk, output_file)

        return output_file, {
            "label_names": self.labels,
            "label_colors": self._label_colors,
        }
