# ILD OHIF Tool

A [MONAI Label](https://github.com/Project-MONAI/MONAILabel) server providing AI-assisted segmentation of CT scans, integrated with the [OHIF Viewer](https://ohif.org/) and [Orthanc](https://www.orthanc-server.com/) DICOM server.

## What it does

Radiologists open a CT scan in OHIF, click a button, and get an AI-generated segmentation overlay — either fully automatic (nnU-Net) or interactive with click/box prompts (DeepEdit, DeepGrow). Labels can be reviewed, corrected, and saved back to Orthanc.

Two apps are included:

| App | Models | Interaction |
|---|---|---|
| `radiology` | nnU-Net Lung, nnU-Net ILD (8-class), DeepEdit, DeepGrow, SegResNet | Automatic + interactive clicks |
| `monaibundle` | Any MONAI Model Zoo bundle (e.g. wholeBody_ct_segmentation) | Automatic |

---

## System architecture

```
OHIF Viewer (browser)
    │  DICOMweb (WADO-RS)
    ▼
Orthanc  ◄──────────────────────────────────────────┐
    │  DICOMweb                                      │ stores segmentation
    ▼                                                │
MONAI Label server  (FastAPI + Uvicorn, port 8000)  │
    ├── radiology app                                │
    │       ├── nnU-Net Lung                         │
    │       ├── nnU-Net ILD (8 classes)              │
    │       ├── DeepEdit / DeepGrow                  │
    │       └── GraphCut scribbles                   │
    └── monaibundle app
            └── MONAI Zoo bundles
```

---

## Prerequisites

- **Conda** (Miniconda or Anaconda)
- **CUDA-capable GPU** (tested on RTX 4090 / H100)
- **Orthanc** running with the DICOMweb plugin enabled
- **OHIF Viewer** configured to point at Orthanc and MONAI Label

### Python environment

All dependencies run inside the `monai081` conda environment:

```bash
conda activate monai081
```

Key packages (already installed in `monai081`):

| Package | Version | Role |
|---|---|---|
| monailabel | 0.8.1 | Server framework |
| monai | 1.5.2 | Transforms, networks, inferers |
| torch | 2.8.0 | Deep learning backend |
| nnunetv2 | 2.5.2 | nnU-Net automatic segmentation |
| simpleitk | 2.5.5 | Medical image I/O |
| fastapi + uvicorn | 0.95 / 0.21 | HTTP server |

---

## Repository structure

```
apps081/
├── radiology/              # Main app (nnU-Net + interactive models)
│   ├── main.py             # App entry point — registers all models
│   ├── lib/
│   │   ├── configs/        # One file per model: labels, paths, network config
│   │   │   ├── nnunet_lung.py
│   │   │   ├── nnunet_ild.py
│   │   │   ├── deepedit.py
│   │   │   └── ...
│   │   ├── infers/         # Inference logic for each model
│   │   │   ├── nnunet.py   # Custom nnU-Net wrapper (bypasses MONAI pipeline)
│   │   │   ├── deepedit.py
│   │   │   ├── deepgrow.py
│   │   │   └── ...
│   │   ├── trainers/       # Active learning fine-tuning (MONAI-native models)
│   │   └── transforms/     # Custom MONAI transforms (centroid extraction, etc.)
│   └── model/              # Model weights — NOT in git, stored separately
│       ├── nnUNet_results/
│       │   ├── Dataset001_Lung/
│       │   └── Dataset003_ILD_raw/
│       └── pretrained_*.pt
│
└── monaibundle/            # Bundle app (MONAI Model Zoo)
    └── main.py
```

> **Model weights are excluded from git** (too large). See [Model weights](#model-weights) below.

---

## Running the server

Activate the environment and start the server from inside the `apps081/` folder.

### Radiology app — nnU-Net Lung segmentation

```bash
conda activate monai081
monailabel start_server \
    --app radiology \
    --studies <ORTHANC_DICOMWEB_URL_OR_LOCAL_FOLDER> \
    --conf models nnunet_lung
```

### Radiology app — nnU-Net ILD segmentation (8 classes)

```bash
monailabel start_server \
    --app radiology \
    --studies <ORTHANC_DICOMWEB_URL_OR_LOCAL_FOLDER> \
    --conf models nnunet_ild
```

### Radiology app — multiple models at once

```bash
monailabel start_server \
    --app radiology \
    --studies <ORTHANC_DICOMWEB_URL_OR_LOCAL_FOLDER> \
    --conf models "nnunet_lung,nnunet_ild,deepedit"
```

### MONAI bundle app — whole-body segmentation

```bash
monailabel start_server \
    --app monaibundle \
    --studies <ORTHANC_DICOMWEB_URL_OR_LOCAL_FOLDER> \
    --conf models wholeBody_ct_segmentation
```

**`--studies`** can be either:
- A local folder of NIfTI/NRRD files: `--studies /path/to/images`
- An Orthanc DICOMweb URL: `--studies http://localhost:8042/dicom-web`

The server starts on **port 8000** by default. The OHIF MONAI Label plugin should be configured to point at `http://<server>:8000`.

---

## Available models

### nnU-Net Lung (`nnunet_lung`)

- **Task**: Binary lung segmentation
- **Label**: `lung` (1)
- **Type**: Fully automatic — no user interaction required
- **Weights**: `radiology/model/nnUNet_results/Dataset001_Lung/nnUNetTrainer__nnUNetPlans__3d_fullres/`

### nnU-Net ILD (`nnunet_ild`)

- **Task**: Multi-class ILD pattern segmentation
- **Labels**: `healthy` (1), `ggo` (2), `reticulation` (3), `consolidation` (4), `honeycombing` (5), `reticulation_ggo` (6), `bronchiectasis` (7), `emphysema` (8)
- **Type**: Fully automatic
- **Weights**: `radiology/model/nnUNet_results/Dataset003_ILD_raw/nnUNetTrainer__nnUNetPlans__3d_fullres/`

### DeepEdit (`deepedit`)

- **Task**: Interactive multi-organ segmentation
- **Type**: Interactive — user provides foreground/background clicks in OHIF which guide the model. Can also run fully automatic.
- **Weights**: `radiology/model/pretrained_deepedit_dynunet.pt`

### DeepGrow 2D / 3D (`deepgrow_2d`, `deepgrow_3d`)

- **Task**: Interactive single-structure segmentation
- **Type**: Interactive — user clicks on a slice to guide segmentation
- **Weights**: `radiology/model/pretrained_deepgrow_2d.pt` / `pretrained_deepgrow_3d.pt`

### GraphCut scribbles

- **`Histogram+GraphCut`** / **`GMM+GraphCut`**: CPU-only, no model weights needed. User draws foreground/background scribbles; graph-cut finds the boundary.

---

## Model weights

Weights are **not stored in this repository**. After cloning, place them in `radiology/model/` following this structure:

```
radiology/model/
├── nnUNet_results/
│   ├── Dataset001_Lung/
│   │   └── nnUNetTrainer__nnUNetPlans__3d_fullres/
│   │       ├── dataset.json
│   │       ├── plans.json
│   │       └── fold_0/
│   │           └── checkpoint_final.pth   (or checkpoint_best.pth)
│   └── Dataset003_ILD_raw/
│       └── nnUNetTrainer__nnUNetPlans__3d_fullres/
│           ├── dataset.json
│           ├── plans.json
│           └── fold_0/
│               └── checkpoint_final.pth
├── pretrained_deepedit_dynunet.pt
├── pretrained_deepgrow_2d.pt
├── pretrained_deepgrow_3d.pt
└── pretrained_segmentation_spleen.pt
```

> **Important for nnU-Net**: the `dataset.json` and `plans.json` files must be present alongside the checkpoint. They can be extracted from the checkpoint itself if missing — see [Reconstructing nnU-Net metadata](#reconstructing-nnunet-metadata).

### Reconstructing nnU-Net metadata from a bare checkpoint

If you only have `checkpoint_best.pth` without the JSON files:

```python
import torch, json, os, shutil

src = "checkpoint_best.pth"
dst = "."   # folder where dataset.json and plans.json should go

ck = torch.load(src, map_location="cpu", weights_only=False)
os.makedirs(os.path.join(dst, "fold_0"), exist_ok=True)

with open(os.path.join(dst, "plans.json"), "w") as f:
    json.dump(ck["init_args"]["plans"], f)
with open(os.path.join(dst, "dataset.json"), "w") as f:
    json.dump(ck["init_args"]["dataset_json"], f)

shutil.move(src, os.path.join(dst, "fold_0", "checkpoint_best.pth"))
```

---

## Adding a new model

1. Create `radiology/lib/configs/my_model.py` — define labels, weight path, and return an `InferTask`:

```python
import os
from monailabel.interfaces.config import TaskConfig
from lib.infers.nnunet import NNUNet

class MyModel(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs)
        self.labels = {"structure": 1}
        self.label_colors = {"structure": [255, 0, 0]}
        self.model_folder = os.path.join(model_dir, "my_model_folder")

    def infer(self) -> dict:
        return {self.name: NNUNet(self.model_folder, labels=self.labels,
                                  label_colors=self.label_colors,
                                  checkpoint="checkpoint_best.pth")}

    def trainer(self):
        return None
```

2. Start the server with `--conf models my_model` — it is auto-discovered by name.

No changes to `main.py` are needed.

---

## Troubleshooting

**Server won't start — "models not found"**
Make sure the model name passed to `--conf models` exactly matches the lowercase filename in `lib/configs/` (e.g. `nnunet_lung` for `lib/configs/nnunet_lung.py`).

**nnU-Net inference fails — "dataset.json not found"**
The model folder is missing `dataset.json` / `plans.json`. See [Reconstructing nnU-Net metadata](#reconstructing-nnunet-metadata).

**OHIF shows no models**
Check that the MONAI Label plugin in OHIF is pointed at the correct server URL and port (default `http://localhost:8000`).

**Out of GPU memory**
nnU-Net uses `tile_step_size=0.5` and mirroring by default. On low-memory GPUs, edit `lib/infers/nnunet.py` and set `use_mirroring=False`.
