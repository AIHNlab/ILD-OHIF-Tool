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

import cornerstone from 'cornerstone-core';
import cornerstoneTools from 'cornerstone-tools';

// Each FreehandRoi point's `.lines` entry is a direct object reference to the
// next point (wraparound to the first), not an index - a plain JSON clone
// would disconnect that reference on restore, so points/lines are handled
// separately from the rest of the measurement data.
function cloneFreehandPoints(points) {
  return points.map(p => ({
    x: p.x,
    y: p.y,
    highlight: p.highlight,
    active: p.active,
  }));
}

function restoreFreehandPoints(clonedPoints) {
  const restored = clonedPoints.map(p => ({ ...p }));
  restored.forEach((p, i) => {
    p.lines = [restored[(i + 1) % restored.length]];
  });
  return restored;
}

export function cloneToolData(toolName, data) {
  if (toolName === 'FreehandRoi') {
    return data.map(d => ({
      ...d,
      handles: { ...d.handles, points: cloneFreehandPoints(d.handles.points) },
    }));
  }
  return data.map(d => JSON.parse(JSON.stringify(d)));
}

function restoreToolData(toolName, clonedData) {
  if (toolName === 'FreehandRoi') {
    return clonedData.map(d => ({
      ...d,
      handles: {
        ...d.handles,
        points: restoreFreehandPoints(d.handles.points),
      },
    }));
  }
  return clonedData.map(d => JSON.parse(JSON.stringify(d)));
}

// Restores a vector-tool snapshot onto the slice it was taken on, even if the
// viewport has since navigated elsewhere - mirrors the imageId-swap idiom
// already used by SmartEdit.initPoints/clearPoints.
function restoreSlice(element, toolName, imageId, snapshot) {
  const enabledElement = cornerstone.getEnabledElement(element);
  const oldImageId = enabledElement.image.imageId;

  enabledElement.image.imageId = imageId;
  cornerstoneTools.clearToolState(element, toolName);
  restoreToolData(toolName, snapshot).forEach(d =>
    cornerstoneTools.addToolState(element, toolName, d)
  );
  enabledElement.image.imageId = oldImageId;

  cornerstone.updateImage(element);
}

// Single unified undo/redo stack for the annotation toolbox. Vector-tool
// entries (Freehand/Rectangle/Circle) carry full before/after snapshots;
// brush/scissors entries are markers only - the actual pixel-diff history is
// already maintained natively by cornerstoneTools' segmentation module, so we
// just delegate to it in the right chronological order.
class HistoryStack {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
  }

  reset() {
    this.undoStack = [];
    this.redoStack = [];
  }

  pushVectorChange(element, toolName, imageId, before, after) {
    this.undoStack.push({ type: 'vector', element, toolName, imageId, before, after });
    this.redoStack = [];
  }

  pushBrushChange(element, labelmapIndex) {
    this.undoStack.push({ type: 'brush', element, labelmapIndex });
    this.redoStack = [];
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) {
      return;
    }

    if (entry.type === 'vector') {
      restoreSlice(entry.element, entry.toolName, entry.imageId, entry.before);
    } else {
      cornerstoneTools
        .getModule('segmentation')
        .setters.undo(entry.element, entry.labelmapIndex);
    }

    this.redoStack.push(entry);
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) {
      return;
    }

    if (entry.type === 'vector') {
      restoreSlice(entry.element, entry.toolName, entry.imageId, entry.after);
    } else {
      cornerstoneTools
        .getModule('segmentation')
        .setters.redo(entry.element, entry.labelmapIndex);
    }

    this.undoStack.push(entry);
  }
}

export default new HistoryStack();
