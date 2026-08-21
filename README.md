# ILD OHIF Tool

A [MONAI Label](https://github.com/Project-MONAI/MONAILabel) server providing AI-assisted segmentation of CT scans, integrated with the [OHIF Viewer](https://ohif.org/) and [Orthanc](https://www.orthanc-server.com/) DICOM server.

## What it does

Radiologists open a CT scan in OHIF and get an AI-generated segmentation overlay — either fully automatic (nnU-Net) or interactive with click/box prompts (MedSAM2). Labels can be reviewed, corrected, and saved back to Orthanc.

Two apps are included:

| App | Purpose |
|---|---|
| `radiology` | Custom nnU-Net models + MONAI defaults |
| `monaibundle` | Any bundle from the MONAI Model Zoo |

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
    └── radiology app                                │
            ├── nnU-Net Lung          (custom)       │
            ├── nnU-Net ILD 8-class   (custom)       │
            └── MedSAM2               (in progress)  │
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

Key packages already installed in `monai081`:

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
├── radiology/                   # Main app
│   ├── main.py                  # Entry point — auto-discovers all models in lib/configs/
│   ├── lib/
│   │   ├── configs/             # One file per model: labels, weight paths, network config
│   │   │   ├── nnunet_lung.py   # custom
│   │   │   ├── nnunet_ild.py    # custom
│   │   │   └── ...              # MONAI defaults (deepedit, deepgrow, segmentation, etc.)
│   │   ├── infers/              # Inference logic
│   │   │   ├── nnunet.py        # Custom nnU-Net wrapper
│   │   │   └── ...              # MONAI-based inferers for default models
│   │   ├── trainers/            # Active learning fine-tuning (MONAI-native models)
│   │   └── transforms/          # Custom MONAI transforms (centroid extraction, etc.)
│   └── model/                   # Model weights — NOT in git, stored separately
│       ├── nnUNet_results/
│       │   ├── Dataset001_Lung/
│       │   ├── Dataset002_ILD/
│       │   └── Dataset003_ILD_raw/
│       └── pretrained_*.pt
│
└── monaibundle/                 # MONAI Model Zoo bundle app
    └── main.py
```

> **Model weights are excluded from git** (too large for GitHub). See [Model weights](#model-weights) below.

---

## Running the server

```bash
conda activate monai081
cd apps081
```

### nnU-Net Lung segmentation

```bash
monailabel start_server \
    --app radiology \
    --studies <ORTHANC_DICOMWEB_URL_OR_LOCAL_FOLDER> \
    --conf models nnunet_lung
```

### nnU-Net ILD segmentation (8 classes)

```bash
monailabel start_server \
    --app radiology \
    --studies <ORTHANC_DICOMWEB_URL_OR_LOCAL_FOLDER> \
    --conf models nnunet_ild
```

### Both models at once

```bash
monailabel start_server \
    --app radiology \
    --studies <ORTHANC_DICOMWEB_URL_OR_LOCAL_FOLDER> \
    --conf models "nnunet_lung,nnunet_ild"
```

**`--studies`** can be:
- A local folder: `--studies /path/to/images`
- An Orthanc DICOMweb URL: `--studies http://localhost:8042/dicom-web`

The server starts on **port 8000** by default.

---

## Models

### `nnunet_lung` — Lung segmentation

- **Type**: Fully automatic
- **Labels**: `lung` (1)
- **Dataset**: `Dataset001_Lung`
- **Weights**: `radiology/model/nnUNet_results/Dataset001_Lung/nnUNetTrainer__nnUNetPlans__3d_fullres/`

### `nnunet_ild` — ILD pattern segmentation

- **Type**: Fully automatic
- **Labels**: `healthy` (1), `ggo` (2), `reticulation` (3), `consolidation` (4), `honeycombing` (5), `reticulation_ggo` (6), `bronchiectasis` (7), `emphysema` (8)
- **Dataset**: `Dataset003_ILD_raw` — ILD segmentation run directly on the raw CT
- **Weights**: `radiology/model/nnUNet_results/Dataset003_ILD_raw/nnUNetTrainer__nnUNetPlans__3d_fullres/`

> **Note on `Dataset002_ILD`**: this dataset uses a two-step approach — the lung is first segmented with `nnunet_lung`, and the ILD segmentation is then run only on the masked lung region. This yields better results but takes longer to run. It is not currently wired to a config file; to use it, duplicate `nnunet_ild.py` and point `model_folder` at `Dataset002_ILD/nnUNetTrainer__nnUNetPlans__3d_fullres/`.

### MedSAM2 — Interactive ILD and Lung segmentation *(in progress)*

- **Type**: Interactive — user draws a bounding box on a representative slice; the model propagates the mask through the volume
- **Trained on**: `Dataset003_ILD_raw` (ILD model) and `Dataset001_Lung` (lung model)
- Integration into MONAI Label is work in progress

### MONAI default models

The following models ship with MONAI Label and are available but not the focus of this project. They can be activated by passing their name to `--conf models`:

| Name | Task |
|---|---|
| `deepedit` | Interactive multi-organ segmentation (clicks) |
| `deepgrow_2d` / `deepgrow_3d` | Interactive single-structure segmentation |
| `segmentation` | Automatic multi-organ SegResNet |
| `segmentation_spleen` | Automatic spleen UNet |
| `localization_spine,localization_vertebra,segmentation_vertebra` | Three-stage vertebra pipeline |
| `Histogram+GraphCut` / `GMM+GraphCut` | Scribble-based, no GPU needed |

Pretrained weights for these download automatically from the MONAI Model Zoo on first run.

---

## Model weights

Weights are **not stored in this repository** (too large for GitHub). They are shared separately via OneDrive — ask the repository owner for the link.

After downloading, place the files inside the repo at exactly this path, preserving the folder structure:

```
apps081/radiology/model/nnUNet_results/
├── Dataset001_Lung/
│   └── nnUNetTrainer__nnUNetPlans__3d_fullres/
│       ├── dataset.json
│       ├── plans.json
│       └── fold_0/
│           └── checkpoint_final.pth          ← lung segmentation weights
│
└── Dataset003_ILD_raw/
    └── nnUNetTrainer__nnUNetPlans__3d_fullres/
        ├── dataset.json
        ├── plans.json
        └── fold_0/
            └── checkpoint_final.pth          ← ILD segmentation weights
```

> The `pretrained_*.pt` files for the MONAI default models (deepedit, deepgrow, etc.) are **not** on OneDrive — they download automatically from the MONAI Model Zoo the first time the server starts.

### Updating or replacing nnU-Net checkpoints

> This section is only relevant when swapping in new model weights. The checkpoints currently used by the server already have the correct structure and do not need this.

nnU-Net requires a specific folder structure alongside the checkpoint file — it will not load a bare `.pth` file on its own:

```
model_folder/
├── dataset.json
├── plans.json
└── fold_0/
    └── checkpoint_best.pth
```

If you receive a new checkpoint as a single `.pth` file (e.g. from a new training run), both `dataset.json` and `plans.json` are actually embedded inside it and can be extracted with this script:

```python
import torch, json, os, shutil

src = "checkpoint_best.pth"   # path to your new checkpoint
dst = "."                      # destination folder (will become the new model_folder)

ck = torch.load(src, map_location="cpu", weights_only=False)
os.makedirs(os.path.join(dst, "fold_0"), exist_ok=True)

with open(os.path.join(dst, "plans.json"), "w") as f:
    json.dump(ck["init_args"]["plans"], f)
with open(os.path.join(dst, "dataset.json"), "w") as f:
    json.dump(ck["init_args"]["dataset_json"], f)

shutil.move(src, os.path.join(dst, "fold_0", "checkpoint_best.pth"))
```

Then update the `model_folder` path in the relevant config file (`nnunet_lung.py` or `nnunet_ild.py`) to point at `dst`, and pass `checkpoint="checkpoint_best.pth"` to the `NNUNet` constructor.

---

## Adding a new model

1. Create `radiology/lib/configs/my_model.py`:

```python
import os
from monailabel.interfaces.config import TaskConfig
from lib.infers.nnunet import NNUNet

class MyModel(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs)
        self.labels = {"structure": 1}
        self.label_colors = {"structure": [255, 0, 0]}
        self.model_folder = os.path.join(model_dir, "my_model_weights/")

    def infer(self) -> dict:
        return {self.name: NNUNet(self.model_folder, labels=self.labels,
                                  label_colors=self.label_colors,
                                  checkpoint="checkpoint_best.pth")}

    def trainer(self):
        return None
```

2. Start the server with `--conf models my_model` — it is discovered automatically by filename. No changes to `main.py` needed.

---

## Troubleshooting

> These are issues you may hit when setting up on a new machine or adding new models — not problems with the currently running setup.

**"models not found" on startup**
The name in `--conf models` must match the lowercase filename in `lib/configs/` exactly (e.g. `nnunet_lung` for `nnunet_lung.py`).

**nnU-Net fails — "dataset.json not found"**
The model folder is missing `dataset.json` / `plans.json`. This happens when a bare checkpoint file is used without the required folder structure. See [Updating or replacing nnU-Net checkpoints](#updating-or-replacing-nnunet-checkpoints).

**OHIF shows no models**
Check that the MONAI Label plugin in OHIF points at the correct server URL (default `http://localhost:8000`).

**Out of GPU memory on large CTs**
Edit `radiology/lib/infers/nnunet.py` and set `use_mirroring=False` in the `nnUNetPredictor` constructor.
