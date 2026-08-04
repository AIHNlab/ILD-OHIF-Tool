import { eventTarget, getEnabledElements } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';

const TRACKED_TOOLS = ['ProbeMONAILabel', 'RectangleROI', 'PlanarFreehandROI'];

type HistoryEntry = { type: 'add' | 'remove'; annotation: any };

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
 * Tracks completed AND removed annotations for the ROI prompt tools (point/
 * rectangle/freehand) so both placing and deleting can be undone/redone.
 * cornerstone3D has no built-in undo/redo, so this listens for
 * ANNOTATION_COMPLETED and ANNOTATION_REMOVED and maintains a single
 * command-style undo/redo stack. ANNOTATION_REMOVED fires for every removal
 * path (right-click "Delete measurement" - single point or whole point-ROI,
 * "Clear Points", and undo/redo's own state mutations), so `suppressTracking`
 * is used while THIS class is the one doing the removing/re-adding, to avoid
 * feeding its own actions back into the history.
 */
class AnnotationHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private suppressTracking = false;

  constructor() {
    eventTarget.addEventListener(
      cornerstoneTools.Enums.Events.ANNOTATION_COMPLETED,
      this.onAnnotationCompleted
    );
    eventTarget.addEventListener(
      cornerstoneTools.Enums.Events.ANNOTATION_REMOVED,
      this.onAnnotationRemoved
    );
  }

  private isTracked = (annotation) =>
    TRACKED_TOOLS.includes(annotation?.metadata?.toolName);

  private onAnnotationCompleted = (evt) => {
    if (this.suppressTracking) {
      return;
    }
    const { annotation } = evt.detail;
    if (!this.isTracked(annotation)) {
      return;
    }
    this.undoStack.push({ type: 'add', annotation });
    this.redoStack = [];
  };

  private onAnnotationRemoved = (evt) => {
    if (this.suppressTracking) {
      return;
    }
    const { annotation } = evt.detail;
    if (!this.isTracked(annotation)) {
      return;
    }
    this.undoStack.push({ type: 'remove', annotation });
    this.redoStack = [];
  };

  private apply = (entry: HistoryEntry, direction: 'undo' | 'redo') => {
    // undoing an 'add' removes it; undoing a 'remove' restores it - and
    // vice-versa for redo.
    const shouldRemove =
      (direction === 'undo' && entry.type === 'add') ||
      (direction === 'redo' && entry.type === 'remove');

    this.suppressTracking = true;
    try {
      if (shouldRemove) {
        cornerstoneTools.annotation.state.removeAnnotation(
          entry.annotation.annotationUID
        );
      } else {
        cornerstoneTools.annotation.state.addAnnotation(entry.annotation);
      }
    } finally {
      this.suppressTracking = false;
    }
    renderAllViewports();
  };

  undo = () => {
    const entry = this.undoStack.pop();
    if (!entry) {
      return;
    }
    this.apply(entry, 'undo');
    this.redoStack.push(entry);
  };

  redo = () => {
    const entry = this.redoStack.pop();
    if (!entry) {
      return;
    }
    this.apply(entry, 'redo');
    this.undoStack.push(entry);
  };

  clearAll = () => {
    this.suppressTracking = true;
    try {
      for (const toolName of TRACKED_TOOLS) {
        cornerstoneTools.annotation.state.removeAnnotations(toolName);
      }
    } finally {
      this.suppressTracking = false;
    }
    this.undoStack = [];
    this.redoStack = [];
    renderAllViewports();
  };
}

export default new AnnotationHistory();
