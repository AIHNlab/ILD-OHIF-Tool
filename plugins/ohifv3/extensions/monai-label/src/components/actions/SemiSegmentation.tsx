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
import { Icon } from '@ohif/ui';
import ModelSelector from '../ModelSelector';
import BaseTab from './BaseTab';
import * as cornerstoneTools from '@cornerstonejs/tools';
import { hideNotification } from '../../utils/GenericUtils';

const SHAPE_TOOLS = {
  point: 'ProbeMONAILabel',
  rectangle: 'RectangleROI',
  freehand: 'PlanarFreehandROI',
};

export default class SemiSegmentation extends BaseTab {
  modelSelector: any;

  constructor(props) {
    super(props);

    this.modelSelector = React.createRef();
    this.state = {
      currentModel: null,
      currentShape: 'point',
      currentLabel: null,
    };
  }

  onSelectModel = (model) => {
    this.setState({ currentModel: model, currentLabel: null });
  };

  onSelectLabel = (evt) => {
    this.setState({ currentLabel: evt.target.value });
  };

  getModelLabels(model) {
    const { info } = this.props;
    const names = (model && info.modelLabelNames[model]) || [];
    return names.filter((name) => name !== 'background');
  }

  // The model dropdown (ModelSelector) silently defaults to its first entry
  // until the user changes it, without telling this component - mirror that
  // here so the label dropdown/inference request stay in sync by default.
  getCurrentLabel(model) {
    const labels = this.getModelLabels(model);
    return this.state.currentLabel || labels[0] || null;
  }

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

  onUndo = () => {
    this.props.commandsManager.runCommand('undoMonaiAnnotation');
  };

  onRedo = () => {
    this.props.commandsManager.runCommand('redoMonaiAnnotation');
  };

  getModels() {
    const { info } = this.props;
    return Object.keys(info.data.models).filter(
      (m) =>
        info.data.models[m].type === 'segmentation' ||
        info.data.models[m].type === 'deepgrow' ||
        info.data.models[m].type === 'vista3d'
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
    return {
      roi: {
        start: [Math.min(...xs), Math.min(...ys), z],
        end: [Math.max(...xs), Math.max(...ys), z],
      },
    };
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
    const currentLabel = this.getCurrentLabel(model);

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
      message: 'Running Semi-Segmentation Inference...',
      type: 'info',
      autoClose: false,
    });

    const config = this.props.onOptionsConfig();
    const params = {
      ...(config && config.infer && config.infer[model] ? config.infer[model] : {}),
      ...(currentLabel ? { label: currentLabel } : {}),
      ...roi,
    };
    const label_names = info.modelLabelNames[model];

    this.props.setBusy(true);
    const response = await this.props
      .client()
      .infer(model, displaySet.SeriesInstanceUID, params);
    this.props.setBusy(false);

    hideNotification(nid, this.notification);
    if (response.status !== 200) {
      this.notification.show({
        title: 'MONAI Label - ' + model,
        message: 'Failed to Run Semi-Segmentation Inference',
        type: 'error',
        duration: 6000,
      });
      return;
    }

    this.notification.show({
      title: 'MONAI Label - ' + model,
      message: 'Running Semi-Segmentation Inference - Successful',
      type: 'success',
      duration: 4000,
    });

    this.props.updateView(response, model, label_names);
  };

  render() {
    const models = this.getModels();
    const display = models.length > 0 ? 'block' : 'none';
    const { currentShape } = this.state;
    // ModelSelector defaults to the first model until the user changes it
    // without telling this component - mirror that default here too.
    const model = this.state.currentModel || models[0] || null;
    const labels = this.getModelLabels(model);
    const currentLabel = this.getCurrentLabel(model);

    return (
      <div className="tab" style={{ display: display }}>
        <input
          type="radio"
          name="rd"
          id={this.tabId}
          className="tab-switch"
          defaultValue="semisegmentation"
          onClick={this.onSelectActionTab}
        />
        <label htmlFor={this.tabId} className="tab-label">
          <span className="tabLabelText">
            Semi-Segmentation
            {this.props.isBusy && (
              <span className="tabBusyIndicator" title="Running…" />
            )}
          </span>
        </label>
        <div className="tab-content">
          <div className="annotationToolRow">
            <button
              className="annotationToolButton"
              title="Point"
              style={{
                backgroundColor:
                  currentShape === 'point' ? '#00a4d9' : 'lightgray',
              }}
              onClick={() => this.onSelectShape('point')}
            >
              <Icon name="tool-probe" width="14px" height="14px" />
              Point
            </button>
            <button
              className="annotationToolButton"
              title="Rectangle"
              style={{
                backgroundColor:
                  currentShape === 'rectangle' ? '#00a4d9' : 'lightgray',
              }}
              onClick={() => this.onSelectShape('rectangle')}
            >
              <Icon name="tool-rectangle" width="14px" height="14px" />
              Rectangle
            </button>
            <button
              className="annotationToolButton"
              title="Freehand"
              style={{
                backgroundColor:
                  currentShape === 'freehand' ? '#00a4d9' : 'lightgray',
              }}
              onClick={() => this.onSelectShape('freehand')}
            >
              <Icon name="icon-tool-freehand-roi" width="14px" height="14px" />
              Freehand
            </button>
            <button
              className="annotationToolButton"
              title="Undo last annotation"
              style={{ backgroundColor: 'lightgray' }}
              onClick={this.onUndo}
            >
              <Icon name="tool-reset" width="14px" height="14px" />
              Undo
            </button>
            <button
              className="annotationToolButton"
              title="Redo annotation"
              style={{ backgroundColor: 'lightgray' }}
              onClick={this.onRedo}
            >
              <Icon name="tool-rotate-right" width="14px" height="14px" />
              Redo
            </button>
          </div>
          <ModelSelector
            ref={this.modelSelector}
            name="semisegmentation"
            title="Semi-Segmentation"
            models={models}
            currentModel={this.state.currentModel}
            onClick={this.onRunInference}
            onSelectModel={this.onSelectModel}
            usage={
              <div style={{ fontSize: 'smaller' }}>
                <br />
                <p>
                  Pick a tool above, draw on the image, then run inference.
                </p>
              </div>
            }
          />
          {labels.length > 0 && (
            <div className="annotationToolRow">
              <label htmlFor="semiSegmentationClass">Class:</label>
              <select
                id="semiSegmentationClass"
                className="selectBox"
                value={currentLabel || ''}
                onChange={this.onSelectLabel}
              >
                {labels.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>
    );
  }
}
