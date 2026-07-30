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
import HistoryStack, { cloneToolData } from '../utils/HistoryStack';

export const VECTOR_TOOL_NAMES = ['FreehandRoi', 'RectangleRoi', 'CircleRoi'];
export const REAL_TOOL_NAMES = ['FreehandRoi', 'RectangleRoi', 'CircleRoi', 'Brush'];

// Point-in-shape tests, all in image-pixel space (the same space
// handles.x/y are stored in), so no canvas/image scale conversion is needed.
function pointInPolygon(point, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function hitTest(toolName, data, point) {
  if (toolName === 'FreehandRoi') {
    return pointInPolygon(point, data.handles.points);
  }

  const { start, end } = data.handles;
  if (toolName === 'CircleRoi') {
    // CircleRoiTool stores handles.start as the center and handles.end as a
    // point on the circumference (radius = distance between the two).
    const radius = Math.hypot(end.x - start.x, end.y - start.y);
    return Math.hypot(point.x - start.x, point.y - start.y) <= radius;
  }

  // RectangleRoi: start/end are opposite corners of an axis-aligned box.
  const xMin = Math.min(start.x, end.x);
  const xMax = Math.max(start.x, end.x);
  const yMin = Math.min(start.y, end.y);
  const yMax = Math.max(start.y, end.y);
  return point.x >= xMin && point.x <= xMax && point.y >= yMin && point.y <= yMax;
}

// Priority order used to pick a single winner when regions overlap - the
// same order is used for hover-highlight and for the actual delete, so
// whatever's highlighted is always exactly what gets removed.
function findHitAcrossTools(element, point) {
  for (const toolName of VECTOR_TOOL_NAMES) {
    const toolState = cornerstoneTools.getToolState(element, toolName);
    const data = toolState ? toolState.data : [];
    const hit = data.find(d => hitTest(toolName, d, point));
    if (hit) {
      return { toolName, data: hit };
    }
  }
  return null;
}

// Singleton controller behind the top-toolbar "Annotation Tools" group.
// Unlike the old sidebar-tab implementation, none of this depends on a React
// component being mounted/entered - listeners are wired once, globally, to
// every cornerstone viewport element as it gets enabled (see initialize()).
class AnnotationToolsController {
  constructor() {
    this.activeSubTool = null;
    this.hoveredAnnotation = null;
    this.deleteClickAttached = false;
    this.deleteElement = null;
    // Cache of the last-known snapshot per tool+slice, used to diff against
    // on every mouseup so undo/redo also covers native ctrl+click point
    // insert/delete on FreehandRoi, not just create/delete of whole regions.
    this.snapshotCache = new Map();
    this.trackedElements = new Map();
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    cornerstone.events.addEventListener(
      cornerstone.EVENTS.ELEMENT_ENABLED,
      this.onElementEnabled
    );
    cornerstone.events.addEventListener(
      cornerstone.EVENTS.ELEMENT_DISABLED,
      this.onElementDisabled
    );
    cornerstone
      .getEnabledElements()
      .forEach(({ element }) => this.attachElementListeners(element));

    document.addEventListener('keydown', this.onKeyDown);
  }

  onElementEnabled = evt => this.attachElementListeners(evt.detail.element);
  onElementDisabled = evt => this.detachElementListeners(evt.detail.element);

  attachElementListeners = element => {
    if (this.trackedElements.has(element)) {
      return;
    }

    const labelmapHandler = () => this.onLabelmapModified(element);
    const mouseUpHandler = () => this.onMouseUp(element);

    element.addEventListener(
      cornerstoneTools.EVENTS.MEASUREMENT_COMPLETED,
      this.onMeasurementCompleted
    );
    element.addEventListener(
      cornerstoneTools.EVENTS.LABELMAP_MODIFIED,
      labelmapHandler
    );
    element.addEventListener('mouseup', mouseUpHandler);

    this.trackedElements.set(element, { labelmapHandler, mouseUpHandler });
  };

  detachElementListeners = element => {
    const handlers = this.trackedElements.get(element);
    if (!handlers) {
      return;
    }

    element.removeEventListener(
      cornerstoneTools.EVENTS.MEASUREMENT_COMPLETED,
      this.onMeasurementCompleted
    );
    element.removeEventListener(
      cornerstoneTools.EVENTS.LABELMAP_MODIFIED,
      handlers.labelmapHandler
    );
    element.removeEventListener('mouseup', handlers.mouseUpHandler);
    this.trackedElements.delete(element);

    if (this.deleteElement === element) {
      this.detachDeleteListener();
    }
  };

  getCurrentImageId = element => cornerstone.getEnabledElement(element).image.imageId;

  getCurrentSliceIndex = element => {
    const stackState = cornerstoneTools.getToolState(element, 'stack');
    const stack = stackState && stackState.data && stackState.data[0];
    return stack ? stack.currentImageIdIndex : undefined;
  };

  snapshotKey = (toolName, imageId) => toolName + '::' + imageId;

  captureCurrent = (element, toolName) => {
    const toolState = cornerstoneTools.getToolState(element, toolName);
    return cloneToolData(toolName, toolState ? toolState.data : []);
  };

  recordVectorChange = (element, toolName) => {
    const imageId = this.getCurrentImageId(element);
    const key = this.snapshotKey(toolName, imageId);
    const before = this.snapshotCache.has(key) ? this.snapshotCache.get(key) : [];
    const after = this.captureCurrent(element, toolName);

    this.snapshotCache.set(key, after);
    HistoryStack.pushVectorChange(element, toolName, imageId, before, after);
  };

  extractPoints = (toolName, measurementData) => {
    if (toolName === 'FreehandRoi') {
      return measurementData.handles.points.map(p => ({ x: p.x, y: p.y }));
    }

    const { start, end } = measurementData.handles;
    if (toolName === 'RectangleRoi') {
      // handles.start/end are only the two diagonal corners cornerstone-tools
      // stores internally - expand to all 4 corners of the box.
      return [
        { x: start.x, y: start.y },
        { x: end.x, y: start.y },
        { x: end.x, y: end.y },
        { x: start.x, y: end.y },
      ];
    }

    // CircleRoi: start is the center, end is a point on the circumference -
    // there's no natural "corner" list, so just report those two as-is.
    return [{ x: start.x, y: start.y }, { x: end.x, y: end.y }];
  };

  onMeasurementCompleted = evt => {
    const { toolName, measurementData, element } = evt.detail;
    if (!VECTOR_TOOL_NAMES.includes(toolName)) {
      return;
    }

    const z = this.getCurrentSliceIndex(element);
    const points = this.extractPoints(toolName, measurementData);

    console.log(
      '[AnnotationTools] ' + toolName + ' completed on slice ' + z,
      points
    );
  };

  // Covers create (the finishing click is itself a mouseup), and native
  // ctrl+click point insert/delete on FreehandRoi - a plain diff against the
  // last known snapshot for this tool+slice, pushed only when something
  // actually changed.
  onMouseUp = element => {
    if (!this.activeSubTool || !VECTOR_TOOL_NAMES.includes(this.activeSubTool)) {
      return;
    }

    const imageId = this.getCurrentImageId(element);
    const key = this.snapshotKey(this.activeSubTool, imageId);
    const before = this.snapshotCache.has(key) ? this.snapshotCache.get(key) : [];
    const after = this.captureCurrent(element, this.activeSubTool);

    if (JSON.stringify(before) === JSON.stringify(after)) {
      return;
    }

    this.snapshotCache.set(key, after);
    HistoryStack.pushVectorChange(element, this.activeSubTool, imageId, before, after);
  };

  onLabelmapModified = element => {
    if (this.activeSubTool !== 'Brush') {
      return;
    }

    const { getters } = cornerstoneTools.getModule('segmentation');
    const labelmapIndex = getters.activeLabelmapIndex(element);
    HistoryStack.pushBrushChange(element, labelmapIndex);
  };

  // Delete is its own mode rather than a plain button: while a draw tool
  // (Rectangle/Circle/Freehand) is active, cornerstone-tools treats any plain
  // click as "start a new shape", so clicking an existing region can't select
  // it for deletion. Switching to Delete mode disables drawing, highlights
  // whichever single region (of any of the three vector types) the mouse is
  // currently over - so overlapping regions never delete more than one at a
  // time - and clicking removes exactly that highlighted region.
  attachDeleteListener = element => {
    if (this.deleteClickAttached) {
      return;
    }
    element.addEventListener('mousemove', this.onDeleteMouseMove);
    element.addEventListener('mousedown', this.onDeleteClick);
    this.deleteElement = element;
    this.deleteClickAttached = true;
  };

  detachDeleteListener = () => {
    if (!this.deleteClickAttached) {
      return;
    }
    this.deleteElement.removeEventListener('mousemove', this.onDeleteMouseMove);
    this.deleteElement.removeEventListener('mousedown', this.onDeleteClick);
    this.deleteClickAttached = false;
    this.clearHoveredAnnotation();
    this.deleteElement = null;
  };

  clearHoveredAnnotation = () => {
    if (!this.hoveredAnnotation) {
      return;
    }
    this.hoveredAnnotation.data.highlight = false;
    this.hoveredAnnotation.data.active = false;
    this.hoveredAnnotation = null;
    if (this.deleteElement) {
      cornerstone.updateImage(this.deleteElement);
    }
  };

  onDeleteMouseMove = evt => {
    const element = this.deleteElement;
    const point = cornerstone.pageToPixel(element, evt.pageX, evt.pageY);
    const found = findHitAcrossTools(element, point);
    const previous = this.hoveredAnnotation;
    const previousData = previous ? previous.data : null;
    const foundData = found ? found.data : null;

    if (previousData === foundData) {
      return;
    }

    if (previousData) {
      previousData.highlight = false;
      previousData.active = false;
    }
    if (foundData) {
      foundData.highlight = true;
      foundData.active = true;
    }

    cornerstone.updateImage(element);
    this.hoveredAnnotation = found;
  };

  onDeleteClick = evt => {
    const element = this.deleteElement;
    const point = cornerstone.pageToPixel(element, evt.pageX, evt.pageY);
    const found = this.hoveredAnnotation || findHitAcrossTools(element, point);

    if (!found) {
      return;
    }

    const z = this.getCurrentSliceIndex(element);

    cornerstoneTools.removeToolState(element, found.toolName, found.data);
    cornerstone.updateImage(element);
    console.log(
      '[AnnotationTools] Deleted ' + found.toolName + ' region on slice ' + z
    );
    this.hoveredAnnotation = null;
    this.recordVectorChange(element, found.toolName);
  };

  resolveElement = viewports => {
    const enabledElements = cornerstone.getEnabledElements();
    const index =
      viewports && typeof viewports.activeViewportIndex === 'number'
        ? viewports.activeViewportIndex
        : 0;
    const enabledElement = enabledElements[index];
    return enabledElement ? enabledElement.element : null;
  };

  deactivateCurrent = () => {
    if (this.activeSubTool === 'Delete') {
      this.detachDeleteListener();
    } else if (this.activeSubTool && REAL_TOOL_NAMES.includes(this.activeSubTool)) {
      // 'enabled' (not 'disabled') keeps the tool's existing annotations
      // visible - a disabled tool's shapes aren't rendered at all, which
      // would make everything drawn with it disappear the moment anything
      // triggers a redraw.
      cornerstoneTools.setToolEnabled(this.activeSubTool, {});
    }
  };

  setActiveTool = (toolName, viewports) => {
    this.deactivateCurrent();

    const element = this.resolveElement(viewports);
    if (!element) {
      this.activeSubTool = null;
      return;
    }

    if (toolName === 'Delete') {
      this.attachDeleteListener(element);
    } else {
      cornerstoneTools.setToolActive(toolName, { mouseButtonMask: 1 });
    }

    this.activeSubTool = toolName;
  };

  cancel = () => {
    if (!this.activeSubTool) {
      return;
    }
    this.deactivateCurrent();
    this.activeSubTool = null;
  };

  undo = () => HistoryStack.undo();
  redo = () => HistoryStack.redo();

  onKeyDown = evt => {
    const tag = evt.target && evt.target.tagName;
    // Don't hijack Ctrl+Z/Ctrl+Y/Esc while the user is typing in a form field
    // elsewhere in the panel (e.g. the settings/options tabs).
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return;
    }

    if (evt.key === 'Escape' || evt.key === 'Esc') {
      this.cancel();
      return;
    }

    if (!evt.ctrlKey) {
      return;
    }

    if (evt.key === 'z' || evt.key === 'Z') {
      evt.preventDefault();
      this.undo();
    } else if (evt.key === 'y' || evt.key === 'Y') {
      evt.preventDefault();
      this.redo();
    }
  };
}

export default new AnnotationToolsController();
