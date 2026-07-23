# ILD OHIF Tool

A [MONAI Label](https://github.com/Project-MONAI/MONAILabel) server providing AI-assisted segmentation of CT scans, integrated with the [OHIF Viewer](https://ohif.org/) and [Orthanc](https://www.orthanc-server.com/) DICOM server.

## What it does

Radiologists open a CT scan in OHIF and get an AI-generated segmentation overlay — either fully automatic (nnU-Net, SegResNet) or interactive with click/box prompts (DeepEdit, DeepGrow, and MedSAM2 — in progress). Labels can be reviewed, corrected, and saved back to Orthanc.

Two apps are included:

| App | Purpose |
|---|---|
| `radiology` | Custom nnU-Net models + MONAI interactive models |
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
            ├── DeepEdit / DeepGrow   (pretrained)   │
            ├── SegResNet multi-organ (pretrained)   │
            ├── Spleen UNet           (pretrained)   │
            ├── Vertebra pipeline     (pretrained)   │
            └── GraphCut scribbles    (no GPU)       │
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
│   │   │   ├── nnunet_lung.py
│   │   │   ├── nnunet_ild.py
│   │   │   ├── deepedit.py
│   │   │   ├── deepgrow_2d.py
│   │   │   ├── deepgrow_3d.py
│   │   │   ├── segmentation.py
│   │   │   ├── segmentation_spleen.py
│   │   │   ├── localization_spine.py
│   │   │   ├── localization_vertebra.py
│   │   │   └── segmentation_vertebra.py
│   │   ├── infers/              # Inference logic
│   │   │   ├── nnunet.py        # Custom nnU-Net wrapper
│   │   │   └── ...              # MONAI-based inferers for all other models
│   │   ├── trainers/            # Active learning fine-tuning (MONAI-native models)
│   │   └── transforms/          # Custom MONAI transforms (centroid extraction, etc.)
│   └── model/                   # Model weights — NOT in git, stored separately
│       ├── nnUNet_results/
│       │   ├── Dataset001_Lung/
│       │   ├── Dataset002_ILD/   # exists on disk but not wired to a config yet
│       │   └── Dataset003_ILD_raw/
│       └── pretrained_*.pt
│
└── monaibundle/                 # MONAI Model Zoo bundle app
    └── main.py
```

> **Model weights are excluded from git** (too large for GitHub). See [Model weights](#model-weights) below.

---

## Running the server

Activate the environment first, then run from inside `apps081/`:

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

### Multiple models at once

```bash
monailabel start_server \
    --app radiology \
    --studies <ORTHANC_DICOMWEB_URL_OR_LOCAL_FOLDER> \
    --conf models "nnunet_lung,nnunet_ild,deepedit"
```

### MONAI bundle app

```bash
monailabel start_server \
    --app monaibundle \
    --studies <ORTHANC_DICOMWEB_URL_OR_LOCAL_FOLDER> \
    --conf models wholeBody_ct_segmentation
```

**`--studies`** can be:
- A local folder: `--studies /path/to/images`
- An Orthanc DICOMweb URL: `--studies http://localhost:8042/dicom-web`

The server starts on **port 8000** by default.

---

## Available models

### `nnunet_lung` — Lung segmentation (custom trained)

- **Type**: Fully automatic
- **Labels**: `lung` (1)
- **Weights**: `radiology/model/nnUNet_results/Dataset001_Lung/nnUNetTrainer__nnUNetPlans__3d_fullres/`

### `nnunet_ild` — ILD pattern segmentation (custom trained)

- **Type**: Fully automatic
- **Labels**: `healthy` (1), `ggo` (2), `reticulation` (3), `consolidation` (4), `honeycombing` (5), `reticulation_ggo` (6), `bronchiectasis` (7), `emphysema` (8)
- **Weights**: `radiology/model/nnUNet_results/Dataset003_ILD_raw/nnUNetTrainer__nnUNetPlans__3d_fullres/`

> Note: `Dataset002_ILD/` also exists in the model folder but is not currently wired to a config. To use it, duplicate `nnunet_ild.py` and update the `model_folder` path.

### `deepedit` — Interactive multi-organ segmentation (pretrained)

- **Type**: Interactive (foreground/background clicks in OHIF) or fully automatic
- **Labels**: spleen, liver, kidney, and others
- **Weights**: `radiology/model/pretrained_deepedit_dynunet.pt` — downloaded automatically on first run

### `deepgrow_2d` / `deepgrow_3d` — Interactive single-structure segmentation (pretrained)

- **Type**: Interactive — user clicks on a slice to guide segmentation
- **Weights**: `pretrained_deepgrow_2d.pt` / `pretrained_deepgrow_3d.pt` — downloaded automatically on first run

### `segmentation` — Multi-organ segmentation SegResNet (pretrained)

- **Type**: Fully automatic
- **Labels**: 24 structures including spleen, kidneys, liver, stomach, aorta, lung lobes, heart chambers
- **Weights**: Downloaded automatically on first run

### `segmentation_spleen` — Spleen segmentation UNet (pretrained)

- **Type**: Fully automatic
- **Labels**: `spleen` (1)
- **Weights**: `radiology/model/pretrained_segmentation_spleen.pt` — downloaded automatically on first run

### Vertebra pipeline — `localization_spine` + `localization_vertebra` + `segmentation_vertebra`

Three-stage pipeline for vertebra segmentation. Must be run together:

```bash
--conf models "localization_spine,localization_vertebra,segmentation_vertebra"
```

- **Labels**: C1–C7, Th1–Th12, L1–L5 (24 vertebrae)
- **Weights**: Downloaded automatically on first run

### GraphCut scribbles — `Histogram+GraphCut` / `GMM+GraphCut`

- **Type**: Interactive scribbles — no neural network, no GPU required
- User draws foreground/background strokes in OHIF; graph-cut finds the boundary
- Always available, no weights needed

---

## Model weights

Weights are **not stored in this repository**. After cloning, place custom-trained weights in `radiology/model/` following this structure:

```
radiology/model/
├── nnUNet_results/
│   ├── Dataset001_Lung/
│   │   └── nnUNetTrainer__nnUNetPlans__3d_fullres/
│   │       ├── dataset.json
│   │       ├── plans.json
│   │       └── fold_0/
│   │           └── checkpoint_final.pth
│   └── Dataset003_ILD_raw/
│       └── nnUNetTrainer__nnUNetPlans__3d_fullres/
│           ├── dataset.json
│           ├── plans.json
│           └── fold_0/
│               └── checkpoint_final.pth
└── pretrained_segmentation_spleen.pt
```

Pretrained MONAI models (`deepedit`, `deepgrow`, `segmentation`, `localization_*`) are **downloaded automatically** from the MONAI Model Zoo on first run.

### Reconstructing nnU-Net metadata from a bare checkpoint

If you only have `checkpoint_best.pth` without `dataset.json` / `plans.json`:

```python
import torch, json, os, shutil

src = "checkpoint_best.pth"
dst = "."  # folder where the JSON files should go

ck = torch.load(src, map_location="cpu", weights_only=False)
os.makedirs(os.path.join(dst, "fold_0"), exist_ok=True)

with open(os.path.join(dst, "plans.json"), "w") as f:
    json.dump(ck["init_args"]["plans"], f)
with open(os.path.join(dst, "dataset.json"), "w") as f:
    json.dump(ck["init_args"]["dataset_json"], f)

shutil.move(src, os.path.join(dst, "fold_0", "checkpoint_best.pth"))
```

Then pass `checkpoint="checkpoint_best.pth"` when instantiating `NNUNet` in the config.

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

**"models not found" on startup**
The name passed to `--conf models` must exactly match the lowercase filename in `lib/configs/` (e.g. `nnunet_lung` for `nnunet_lung.py`).

**nnU-Net fails — "dataset.json not found"**
The model folder is missing `dataset.json` / `plans.json`. See [Reconstructing nnU-Net metadata](#reconstructing-nnunet-metadata-from-a-bare-checkpoint).

**OHIF shows no models**
Check that the MONAI Label plugin in OHIF is pointed at the correct server URL (default `http://localhost:8000`).

**Out of GPU memory on large CTs**
Edit `radiology/lib/infers/nnunet.py` and set `use_mirroring=False` in the `nnUNetPredictor` constructor.
