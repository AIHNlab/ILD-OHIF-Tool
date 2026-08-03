/*
Copyright (c) MONAI Consortium
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React from 'react';
import ModelSelector from '../ModelSelector';
import BaseTab from './BaseTab';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { hideNotification } from '../../utils/GenericUtils';

const SHAPE_TOOLS = {
  point: 'ProbeMONAILabel',
  rectangle: 'RectangleROI',
  freehand: 'PlanarFreehandROI',
};

export default class ROIPrompts extends BaseTab {
  modelSelector: any;

  constructor(props) {
    super(props);

    this.modelSelector = React.createRef();
    this.state = {
      currentModel: null,
      currentShape: 'point',
    };
  }

  onSelectModel = (model) => {
    this.setState({ currentModel: model });
  };

  onSelectShape = (shape) => {
    this.activateShapeTool(shape);
    this.setState({ currentShape: shape });
  };

  activateShapeTool = (shape) => {
    this.props.commandsManager.runCommand('setToolDisable', {
      toolName: SHAPE_TOOLS[this.state.currentShape],
    });
    this.props.commandsManager.runCommand('setToolActive', {
      toolName: SHAPE_TOOLS[shape],
    });
  };

  onEnterActionTab = () => {
    this.props.commandsManager.runCommand('setToolActive', {
      toolName: SHAPE_TOOLS[this.state.currentShape],
    });
  };

  onLeaveActionTab = () => {
    this.props.commandsManager.runCommand('setToolDisable', {
      toolName: SHAPE_TOOLS[this.state.currentShape],
    });
  };

  getModels() {
    const { info } = this.props;
    return Object.keys(info.data.models).filter(
      (m) => info.data.models[m].type === 'deepgrow'
    );
  }

  getWorldToIndex() {
    const { viewport } = this.props.getActiveViewportInfo();
    const { cornerstoneViewportService } = this.props.servicesManager.services;
    const viewportInfo = cornerstoneViewportService.getViewportInfo(
      viewport.viewportId
    );
    return viewportInfo.viewportData.data[0].volume.imageData.worldToIndex;
  }

  buildPointParams() {
    const worldToIndex = this.getWorldToIndex();
    const manager = cornerstoneTools.annotation.state.getAnnotationManager();
    const saved = manager.saveAnnotations(null, 'ProbeMONAILabel');

    let points = [];
    for (const uid in saved) {
      for (const annotation of saved[uid]['ProbeMONAILabel'] || []) {
        points.push(worldToIndex(annotation.data.handles.points[0]).map(Math.round));
      }
    }
    if (!points.length) {
      return null;
    }
    return { foreground: points };
  }

  buildRectangleParams() {
    const worldToIndex = this.getWorldToIndex();
    const manager = cornerstoneTools.annotation.state.getAnnotationManager();
    const saved = manager.saveAnnotations(null, 'RectangleROI');

    let corners = [];
    for (const uid in saved) {
      for (const annotation of saved[uid]['RectangleROI'] || []) {
        for (const pt of annotation.data.handles.points) {
          corners.push(worldToIndex(pt).map(Math.round));
        }
      }
    }
    if (!corners.length) {
      return null;
    }

    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const z = corners[0][2];
    return { box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), z] };
  }

  buildFreehandParams() {
    const worldToIndex = this.getWorldToIndex();
    const manager = cornerstoneTools.annotation.state.getAnnotationManager();
    const saved = manager.saveAnnotations(null, 'PlanarFreehandROI');

    let vertices = [];
    for (const uid in saved) {
      for (const annotation of saved[uid]['PlanarFreehandROI'] || []) {
        for (const pt of annotation.data.contour.polyline) {
          vertices.push(worldToIndex(pt).map(Math.round));
        }
      }
    }
    if (!vertices.length) {
      return null;
    }

    const z = vertices[0][2];
    return {
      mask_polygon: vertices.map((p) => [p[0], p[1]]),
      roi_slice: z,
    };
  }

  onRunInference = async () => {
    const { currentModel, currentShape } = this.state;
    const { info } = this.props;
    const { displaySet } = this.props.getActiveViewportInfo();

    const models = this.getModels();
    let selectedModel = 0;
    for (const model of models) {
      if (!currentModel || model === currentModel) {
        break;
      }
      selectedModel++;
    }
    const model = models.length > 0 ? models[selectedModel] : null;
    if (!model) {
      this.notification.show({
        title: 'MONAI Label',
        message: 'Something went wrong: Model is not selected',
        type: 'error',
        duration: 10000,
      });
      return;
    }

    const roiBuilders = {
      point: this.buildPointParams,
      rectangle: this.buildRectangleParams,
      freehand: this.buildFreehandParams,
    };
    const roi = roiBuilders[currentShape].call(this);
    if (!roi) {
      this.notification.show({
        title: 'MONAI Label - ' + model,
        message: `Draw a ${currentShape} on the image first`,
        type: 'error',
        duration: 6000,
      });
      return;
    }

    const nid = this.notification.show({
      title: 'MONAI Label - ' + model,
      message: 'Running ROI Prompt Inference...',
      type: 'info',
      autoClose: false,
    });

    const config = this.props.onOptionsConfig();
    const params = {
      ...(config && config.infer && config.infer[model] ? config.infer[model] : {}),
      ...roi,
    };
    const label_names = info.modelLabelNames[model];

    const response = await this.props
      .client()
      .infer(model, displaySet.SeriesInstanceUID, params);

    hideNotification(nid, this.notification);
    if (response.status !== 200) {
      this.notification.show({
        title: 'MONAI Label - ' + model,
        message: 'Failed to Run Inference for ROI Prompt',
        type: 'error',
        duration: 6000,
      });
      return;
    }

    this.notification.show({
      title: 'MONAI Label - ' + model,
      message: 'Running Inference for ROI Prompt - Successful',
      type: 'success',
      duration: 4000,
    });

    this.props.updateView(response, model, label_names);
  };

  render() {
    const models = this.getModels();
    const display = models.length > 0 ? 'block' : 'none';
    const { currentShape } = this.state;

    return (
      <div className="tab" style={{ display: display }}>
        <input
          type="radio"
          name="rd"
          id={this.tabId}
          className="tab-switch"
          defaultValue="roiprompts"
          onClick={this.onSelectActionTab}
        />
        <label htmlFor={this.tabId} className="tab-label">
          ROI Prompts
        </label>
        <div className="tab-content">
          <ModelSelector
            ref={this.modelSelector}
            name="roiprompts"
            title="ROIPrompts"
            models={models}
            currentModel={this.state.currentModel}
            onClick={this.onRunInference}
            onSelectModel={this.onSelectModel}
            usage={
              <div style={{ fontSize: 'smaller' }}>
                <br />
                <p>Draw a region of interest, then run inference.</p>
                <p>
                  <label>
                    <input
                      type="radio"
                      name="roi-shape"
                      checked={currentShape === 'point'}
                      onChange={() => this.onSelectShape('point')}
                    />
                    &nbsp;Point&nbsp;
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="roi-shape"
                      checked={currentShape === 'rectangle'}
                      onChange={() => this.onSelectShape('rectangle')}
                    />
                    &nbsp;Rectangle&nbsp;
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="roi-shape"
                      checked={currentShape === 'freehand'}
                      onChange={() => this.onSelectShape('freehand')}
                    />
                    &nbsp;Freehand
                  </label>
                </p>
              </div>
            }
          />
        </div>
      </div>
    );
  }
}
