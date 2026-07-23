import os
from monailabel.interfaces.config import TaskConfig
from lib.infers.nnunet import NNUNet

class NNUNetILD(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs)
        self.labels = {
            "healthy": 1, "ggo": 2, "reticulation": 3, "consolidation": 4,
            "honeycombing": 5, "reticulation_ggo": 6, "bronchiectasis": 7,
            "emphysema": 8,
        }
        self.label_colors = {
            "healthy":          [128, 174, 128],   # muted green
            "ggo":              [241, 214, 145],    # pale yellow
            "reticulation":     [177,  122, 101],   # brown
            "consolidation":    [216, 101,  79],    # red-orange
            "honeycombing":     [221, 130, 101],    # salmon
            "reticulation_ggo": [144, 238, 144],    # light green
            "bronchiectasis":   [ 78, 171, 250],    # blue
            "emphysema":        [192, 104, 191],    # purple
        }
        self.model_folder = os.path.join(
            model_dir, "nnUNet_results/Dataset003_ILD_raw/nnUNetTrainer__nnUNetPlans__3d_fullres")

    def infer(self) -> dict:
        return {self.name: NNUNet(self.model_folder, labels=self.labels,
                                  label_colors=self.label_colors)}

    def trainer(self):
        return None