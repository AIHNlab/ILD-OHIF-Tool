import { eventTarget, getEnabledElements } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';

const TRACKED_TOOLS = ['ProbeMONAILabel', 'RectangleROI', 'PlanarFreehandROI'];

/**
 * Removing/re-adding annotations via the state API doesn't trigger the SVG
 * annotation overlay to redraw on its own (that only happens on tool
 * interaction or viewport events), so undo/redo must force it explicitly.
 */
function renderAllViewports() {
  const viewportIds = getEnabledElements()
    .map((el) => el?.viewportId)
    .filter(Boolean);
  cornerstoneTools.utilities.triggerAnnotationRenderForViewportIds(viewportIds);
}

/**
 * Tracks completed annotations for the ROI prompt tools (point/rectangle/
 * freehand) so they can be undone/redone. cornerstone3D has no built-in
 * undo/redo, so this listens for ANNOTATION_COMPLETED and maintains a simple
 * two-stack history (undo/redo) of annotation objects.
 */
class AnnotationHistory {
  private undoStack: string[] = [];
  private redoStack: any[] = [];

  constructor() {
    eventTarget.addEventListener(
      cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED,
      this.onAnnotationCompleted
    );
  }

  private onAnnotationCompleted = (evt) => {
    const { annotation } = evt.detail;
    if (!TRACKED_TOOLS.includes(annotation.metadata?.toolName)) {
      return;
    }
    this.undoStack.push(annotation.annotationUID);
    this.redoStack = [];
  };

  undo = () => {
    const uid = this.undoStack.pop();
    if (!uid) {
      return;
    }
    const manager = cornerstoneTools.annotation.state.getAnnotationManager();
    const annotation = manager.getAnnotation(uid);
    if (annotation) {
      this.redoStack.push(annotation);
      cornerstoneTools.annotation.state.removeAnnotation(uid);
      renderAllViewports();
    }
  };

  redo = () => {
    const annotation = this.redoStack.pop();
    if (!annotation) {
      return;
    }
    cornerstoneTools.annotation.state.addAnnotation(annotation);
    this.undoStack.push(annotation.annotationUID);
    renderAllViewports();
  };

  clearAll = () => {
    for (const toolName of TRACKED_TOOLS) {
      cornerstoneTools.annotation.state.removeAnnotations(toolName);
    }
    this.undoStack = [];
    this.redoStack = [];
    renderAllViewports();
  };
}

export default new AnnotationHistory();
