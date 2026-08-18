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
import { getEnabledElements } from '@cornerstonejs/core';
import { hideNotification } from '../../utils/GenericUtils';
import { renderAllViewports } from '../../utils/AnnotationHistory';

const SHAPE_TOOLS = {
  point: 'ProbeMONAILabel',
  rectangle: 'RectangleROI',
  freehand: 'PlanarFreehandROI',
  // CircularBrush/CircularEraser are cornerstone3D's own labelmap-editing
  // tools (already registered passively in initToolGroups.js for the
  // segmentation toolbox) - reused here rather than built from scratch,
  // since exclude/add for a brush is exactly their existing fill/erase
  // strategy pair.
  brush: 'CircularBrush',
};

// Exclude is a mode, not a fourth shape: it swaps whichever shape tool is
// active for its "exclude" counterpart, so the same point/box/freehand
// interactions draw a region to remove instead of a region to add.
const EXCLUDE_SHAPE_TOOLS = {
  point: 'ProbeMONAILabelExclude',
  rectangle: 'RectangleROIExclude',
  freehand: 'PlanarFreehandROIExclude',
  brush: 'CircularEraser',
};

// Half-width of the local neighborhood a point prompt expands to, matching
// nnU-Net's own XY_MIN_SIZE=96 padding (radiology/lib/infers/nnunet.py) -
// keep these in sync, this only affects which merge region gets protected
// on the frontend, not what the backend actually crops/classifies.
const POINT_NEIGHBORHOOD_RADIUS = 48;

// Mirrors sam2_interactive.py's MAX_FRAMES_TO_TRACK. SAM2 only ever writes
// (or genuinely decides) anything within this many slices of the prompted
// slice - everywhere else its result array is just a zero-filled
// placeholder that was never inferenced, not an actual "not this class"
// decision. The merge in updateView can't tell those apart on its own, so
// runs against the SAM2 model attach a z range here to keep it from
// overwriting real earlier labels on slices SAM2 never looked at. nnU-Net's
// rectangle/freehand path is deliberately left z-unbounded (see
// nnunet.py's _roi_to_bbox) since its result IS a real full-depth
// classification, not a placeholder.
const SAM2_MAX_FRAMES_TO_TRACK = 60;

// Mirrors sam2_interactive.py's BRUSH_PATCH_MARGIN - a brush stroke is
// already pixel-exact, so this only needs enough room for SAM2 to
// refine/shift slightly slice to slice, not to grow an outline.
const BRUSH_NEIGHBORHOOD_MARGIN = 24;

// Half of nnunet.py's Z_MIN_SIZE - a point's hull is grown from local pixel
// similarity on ONE slice, so (unlike a hand-drawn rectangle/freehand ROI,
// which nnU-Net deliberately classifies through the whole study depth)
// nnU-Net only ever classifies a small z window around that slice for a
// point prompt. Without a matching z bound here, the merge would read every
// slice outside that window - never actually inferenced, just a zero-filled
// placeholder - as "nnU-Net decided background here" and wipe out real,
// unrelated segmentation from earlier runs on those slices.
const POINT_Z_MARGIN = 32;

// Matches initToolGroups.js's own CircularBrush/CircularEraser default -
// this is just the initial value the slider starts at; the tool's actual
// configured size always tracks state.brushSize once the component mounts.
const DEFAULT_BRUSH_SIZE = 5;
const MIN_BRUSH_SIZE = 1;
const MAX_BRUSH_SIZE = 20;

const UndoIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16px"
    height="16px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </svg>
);

const RedoIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16px"
    height="16px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="15 14 20 9 15 4" />
    <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
  </svg>
);

const ExcludeIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16px"
    height="16px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <line x1="7" y1="12" x2="17" y2="12" />
  </svg>
);

const ResetIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16px"
    height="16px"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);

export default class SemiSegmentation extends BaseTab {
  modelSelector: any;

  constructor(props) {
    super(props);

    this.modelSelector = React.createRef();
    this.state = {
      currentModel: null,
      currentShape: 'point',
      currentLabel: null,
      excludeMode: false,
      // Baseline for the brush tool's before/after diff (see snapshotBrush
      // and buildBrushParamsList) - null means no brush edits are pending.
      brushSnapshot: null,
      // Radius (mm) CircularBrush/CircularEraser paint/erase with - see
      // onBrushSizeChange/applyBrushSize.
      brushSize: DEFAULT_BRUSH_SIZE,
    };
  }

  componentDidMount() {
    super.componentDidMount();
    // initToolGroups.js sets the tools' own default at registration time,
    // before this component (or its state) exists - push this component's
    // default onto them explicitly so the slider's starting position and
    // the tool's actual size are never out of sync.
    this.applyBrushSize(this.state.brushSize);
  }

  // Pushes the given radius (mm) onto both CircularBrush and CircularEraser
  // in the active viewport's tool group - both, always, regardless of which
  // one (paint vs erase) is currently active, so switching Exclude on/off
  // never leaves the two tools at different sizes.
  applyBrushSize = (size) => {
    const { toolGroupService } = this.props.servicesManager?.services || {};
    const toolGroup = toolGroupService?.getToolGroup();
    if (!toolGroup) {
      return;
    }
    cornerstoneTools.utilities.segmentation.setBrushSizeForToolGroup(
      toolGroup.id,
      size
    );
  };

  onBrushSizeChange = (evt) => {
    const size = Number(evt.target.value);
    this.setState({ brushSize: size });
    this.applyBrushSize(size);
  };

  onSelectModel = (model) => {
    // currentLabel is cleared since the two models' class lists may differ
    // (and SAM2 requires re-confirming one before Run either way) - but
    // brushSnapshot is left alone: it's keyed by segment index, which is a
    // property of the segmentation itself, not of whichever model happens
    // to be selected, so a pending not-yet-sent brush edit stays valid
    // across a model switch instead of being silently discarded.
    this.setState({ currentModel: model, currentLabel: null });
  };

  onSelectLabel = (label) => {
    this.setState({ currentLabel: label }, () => {
      if (this.state.currentShape !== 'brush') {
        return;
      }
      const segIndex = this.segmentInfo()[label]?.segmentIndex;
      const { brushSnapshot } = this.state;
      if (brushSnapshot && segIndex != null && brushSnapshot.segIndex === segIndex) {
        // Re-confirming the same class this session's pending edit already
        // belongs to (e.g. re-picking it after currentLabel got cleared by
        // a model switch) - keep the existing baseline so that edit isn't
        // discarded, just make sure the brush is still targeting/locked to it.
        this.activateBrushSegment(segIndex);
        return;
      }
      this.snapshotBrush();
    });
  };

  segColorToRgb(s) {
    const c = s ? s.color : [0, 0, 0];
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }

  getModelLabels(model) {
    const { info } = this.props;
    const names = (model && info.modelLabelNames[model]) || [];
    return names.filter((name) => name !== 'background');
  }

  toolNameFor(shape, excludeMode) {
    return excludeMode ? EXCLUDE_SHAPE_TOOLS[shape] : SHAPE_TOOLS[shape];
  }

  onSelectShape = (shape) => {
    const { currentShape, excludeMode } = this.state;
    if (shape === currentShape) {
      // Already this shape - re-running the tool swap is a no-op anyway,
      // and re-snapshotting here would silently discard a pending,
      // not-yet-sent brush edit for no reason.
      return;
    }
    this.props.commandsManager.runCommand('setToolDisable', {
      toolName: this.toolNameFor(currentShape, excludeMode),
    });
    this.props.commandsManager.runCommand('setToolActive', {
      toolName: this.toolNameFor(shape, excludeMode),
    });
    this.setState({ currentShape: shape }, () => {
      if (shape !== 'brush') {
        return;
      }
      // Only arm a fresh baseline if there isn't one already pending -
      // switching to brush, away, and back (e.g. to draw a point in
      // between) shouldn't discard an edit still waiting to be Run.
      if (!this.state.brushSnapshot) {
        this.snapshotBrush();
      }
      // The tool group may not have existed yet at componentDidMount (e.g.
      // panel opened before the viewport finished initializing) - re-apply
      // here too so the slider's value is never stale once brush is
      // actually selectable.
      this.applyBrushSize(this.state.brushSize);
    });
  };

  // Toggles exclude mode without changing which shape is selected - swaps
  // the active tool for its exclude counterpart (see EXCLUDE_SHAPE_TOOLS),
  // so the next thing you draw with the same shape removes instead of adds.
  onToggleExclude = () => {
    const { currentShape, excludeMode } = this.state;
    const nextExcludeMode = !excludeMode;
    this.props.commandsManager.runCommand('setToolDisable', {
      toolName: this.toolNameFor(currentShape, excludeMode),
    });
    this.props.commandsManager.runCommand('setToolActive', {
      toolName: this.toolNameFor(currentShape, nextExcludeMode),
    });
    this.setState({ excludeMode: nextExcludeMode });
  };

  onEnterActionTab = () => {
    const { currentShape, excludeMode } = this.state;
    this.props.commandsManager.runCommand('setToolActive', {
      toolName: this.toolNameFor(currentShape, excludeMode),
    });
  };

  onLeaveActionTab = () => {
    const { currentShape, excludeMode } = this.state;
    this.props.commandsManager.runCommand('setToolDisable', {
      toolName: this.toolNameFor(currentShape, excludeMode),
    });
  };

  onUndo = () => {
    this.props.commandsManager.runCommand('undoMonaiAnnotation');
  };

  onRedo = () => {
    this.props.commandsManager.runCommand('redoMonaiAnnotation');
  };

  onReset = () => {
    if (!window.confirm('Reset all segments? This clears the entire segmentation and cannot be undone.')) {
      return;
    }
    this.props.resetSegmentation();
  };

  // Every current point annotation always combines into one shared prompt
  // (see buildPointParamsList), so leftover points from a prior run would
  // otherwise silently get pulled into the next one's outline too. Clearing
  // them right after they're used keeps each run's points scoped to just
  // that run - this goes through the normal state API (not AnnotationHistory's
  // own suppressed removal), so it's still trackable via the Undo button.
  // removeAnnotations(toolName) alone always throws ("Element not enabled,
  // you must have an enabled element if you are not providing a
  // FrameOfReferenceUID") - its 2nd argument is required and only resolves
  // automatically from an actual DOM element, which nothing provides when
  // called from here (not a native cornerstone event handler). Resolve
  // every FrameOfReferenceUID currently on screen instead (MPR's 3
  // viewports usually share one, but don't assume that) and pass it
  // explicitly, same as AnnotationHistory.ts's renderAllViewports does for
  // enabled elements.
  forEachFrameOfReference = (fn) => {
    const seen = new Set();
    getEnabledElements().forEach((el) => {
      const forUID = el?.FrameOfReferenceUID;
      if (forUID && !seen.has(forUID)) {
        seen.add(forUID);
        fn(forUID);
      }
    });
  };

  clearPointAnnotations = () => {
    this.forEachFrameOfReference((forUID) =>
      cornerstoneTools.annotation.state.removeAnnotations('ProbeMONAILabel', forUID)
    );
    renderAllViewports();
  };

  // Same "consumed once used" reasoning as clearPointAnnotations - an
  // exclude shape is a one-shot correction to whatever run it was attached
  // to, not a standing marker.
  clearExcludeAnnotations = () => {
    this.forEachFrameOfReference((forUID) => {
      Object.values(EXCLUDE_SHAPE_TOOLS).forEach((toolName) => {
        cornerstoneTools.annotation.state.removeAnnotations(toolName, forUID);
      });
    });
    renderAllViewports();
  };

  getModels() {
    const { info } = this.props;
    // Both prompt-driven models belong here: 'deepgrow' (SAM2 - genuine
    // object-mask tracing, single class per run) and 'segmentation'
    // (nnU-Net - classifies the prompted region into all classes at once).
    // Same type-based filtering AutoSegmentation.tsx uses for its own list.
    return Object.keys(info.data.models).filter(
      (m) =>
        info.data.models[m].type === 'deepgrow' ||
        info.data.models[m].type === 'segmentation'
    );
  }

  isSam2Model(model) {
    const { info } = this.props;
    return model && info.data.models[model]?.type === 'deepgrow';
  }

  getWorldToIndex() {
    const { viewport } = this.props.getActiveViewportInfo();
    const { cornerstoneViewportService } = this.props.servicesManager.services;
    const viewportInfo = cornerstoneViewportService.getViewportInfo(
      viewport.viewportId
    );
    return viewportInfo.viewportData.data[0].volume.imageData.worldToIndex;
  }

  getElement() {
    const { viewport } = this.props.getActiveViewportInfo();
    const { cornerstoneViewportService } = this.props.servicesManager.services;
    return cornerstoneViewportService.getCornerstoneViewport(viewport.viewportId)
      .element;
  }

  // Whole volume's worth of "is this voxel currently segIndex" - used both to
  // snapshot the brush baseline and, at Run time, to read back the current
  // state for diffing against it. Deliberately not scoped to "the current
  // slice": the user can pick the brush tool/class on one slice and then
  // scroll before actually painting, so pinning a slice index up front at
  // snapshot time can end up diffing a slice nothing ever touched. Scanning
  // the whole volume finds whichever slice(s) actually changed instead.
  readClassVolumeMask(segIndex) {
    const { segmentationService } = this.props.servicesManager.services;
    const volumeLoadObject = segmentationService.getLabelmapVolume('1');
    const [width] = volumeLoadObject?.dimensions || [];
    const scalarData = volumeLoadObject?.voxelManager?.getCompleteScalarDataArray();
    if (!scalarData || !width) {
      return null;
    }
    const numImageFrames = this.props.getActiveViewportInfo().displaySet.numImageFrames;
    const sliceLength = scalarData.length / numImageFrames;
    const mask = new Uint8Array(scalarData.length);
    for (let i = 0; i < scalarData.length; i++) {
      mask[i] = scalarData[i] === segIndex ? 1 : 0;
    }
    return { mask, width, sliceLength };
  }

  // CircularBrush/CircularEraser otherwise touch whatever class's voxels
  // happen to be under the circle, not just the one currently selected -
  // cornerstone3D's fill/erase strategies already skip any segment index
  // present in this list (used for its own "locked segment" feature), so
  // locking every class except the active one is what keeps a paint or
  // erase stroke scoped to just that class, leaving anything else already
  // labeled there untouched either way.
  activateBrushSegment(segIndex) {
    cornerstoneTools.segmentation.segmentIndex.setActiveSegmentIndex('1', segIndex);
    Object.values(this.segmentInfo()).forEach(({ segmentIndex: otherIndex }) => {
      try {
        cornerstoneTools.segmentation.segmentLocking.setSegmentIndexLocked(
          '1',
          otherIndex,
          otherIndex !== segIndex
        );
      } catch (e) {
        // Segment not yet registered in cornerstone3D's own segmentation
        // state (still just an OHIF-level entry) - nothing to lock yet.
      }
    });
  }

  // Arms a fresh brush baseline: the current state of the selected class
  // across the whole volume. Also points CircularBrush/CircularEraser at
  // that class's segment index, so painting actually edits it rather than
  // whichever segment was last active. Called on entering brush mode and on
  // picking/changing the class while already in it - but NOT if doing so
  // would just re-baseline against a not-yet-sent edit for the exact same
  // class (see onSelectShape/onSelectLabel), which would silently discard it.
  snapshotBrush = () => {
    const { currentLabel } = this.state;
    const segIndex = currentLabel && this.segmentInfo()[currentLabel]?.segmentIndex;
    if (segIndex == null) {
      this.setState({ brushSnapshot: null });
      return;
    }
    this.activateBrushSegment(segIndex);
    const snapshot = this.readClassVolumeMask(segIndex);
    this.setState({
      brushSnapshot: snapshot ? { segIndex, ...snapshot } : null,
    });
  };

  // Reads live annotations directly instead of AnnotationManager.saveAnnotations(),
  // which structuredClone()s the whole state - PlanarFreehandROI annotations carry
  // a non-cloneable onInterpolationComplete callback (attached by cornerstone
  // itself), which throws a DataCloneError as soon as any freehand ROI exists.
  getToolAnnotations(toolName) {
    return cornerstoneTools.annotation.state.getAnnotations(
      toolName,
      this.getElement()
    );
  }

  // Points are seeds for ONE shared region, not independent prompts: the
  // backend grows a real, edge-aware region from them (graph-based region
  // growing, not a shape that just connects the clicks), so every current
  // point annotation combines into a single prompt here - unlike the
  // rectangle/freehand builders below, which batch one prompt per shape.
  buildPointParamsList() {
    const worldToIndex = this.getWorldToIndex();
    const annotations = this.getToolAnnotations('ProbeMONAILabel');
    if (!annotations.length) {
      return [];
    }

    const points = annotations.map((annotation) =>
      worldToIndex(annotation.data.handles.points[0]).map(Math.round)
    );
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    // Padded bounding box around all points - a safe upper bound for the
    // merge-protection region regardless of whether the backend ends up
    // tracing a hull (which stays within this box) or falling back to a
    // small local neighborhood for <3 points.
    return [
      {
        kind: 'point',
        params: { foreground: points },
        xyBounds: {
          xmin: Math.min(...xs) - POINT_NEIGHBORHOOD_RADIUS,
          ymin: Math.min(...ys) - POINT_NEIGHBORHOOD_RADIUS,
          xmax: Math.max(...xs) + POINT_NEIGHBORHOOD_RADIUS,
          ymax: Math.max(...ys) + POINT_NEIGHBORHOOD_RADIUS,
        },
        // points[0][2]: same "points share one key slice" assumption the
        // backend already makes for this prompt (nnunet.py/sam2_interactive.py
        // both key off foreground[0]'s z).
        z: points[0][2],
      },
    ];
  }

  // A box prompt is inherently a single box, so every rectangle currently in
  // the viewport (old ones aren't auto-cleared) becomes its own separate
  // prompt/run here - drawing several boxes then hitting Run once processes
  // all of them, instead of silently unioning them into one giant box or
  // only acting on whichever was drawn most recently.
  buildRectangleParamsList() {
    const worldToIndex = this.getWorldToIndex();
    const annotations = this.getToolAnnotations('RectangleROI');

    return annotations.map((annotation) => {
      const corners = annotation.data.handles.points.map((pt) =>
        worldToIndex(pt).map(Math.round)
      );
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      const z = corners[0][2];
      const xmin = Math.min(...xs);
      const ymin = Math.min(...ys);
      const xmax = Math.max(...xs);
      const ymax = Math.max(...ys);
      return {
        params: { roi: { start: [xmin, ymin, z], end: [xmax, ymax, z] } },
        xyBounds: { xmin, ymin, xmax, ymax },
        z,
      };
    });
  }

  // Same reasoning as buildRectangleParamsList: one drawn polygon = one prompt.
  buildFreehandParamsList() {
    const worldToIndex = this.getWorldToIndex();
    const annotations = this.getToolAnnotations('PlanarFreehandROI');

    return annotations.map((annotation) => {
      const vertices = annotation.data.contour.polyline.map((pt) =>
        worldToIndex(pt).map(Math.round)
      );
      const z = vertices[0][2];
      const xs = vertices.map((p) => p[0]);
      const ys = vertices.map((p) => p[1]);
      return {
        params: {
          mask_polygon: vertices.map((p) => [p[0], p[1]]),
          roi_slice: z,
        },
        xyBounds: {
          xmin: Math.min(...xs),
          ymin: Math.min(...ys),
          xmax: Math.max(...xs),
          ymax: Math.max(...ys),
        },
        z,
      };
    });
  }

  // CircularBrush/CircularEraser edit the segmentation directly, so there's
  // no annotation to build a prompt from - instead this diffs the current
  // whole-volume state of the snapshotted class (see snapshotBrush) against
  // that baseline, then groups whatever changed by slice (the user may have
  // scrolled and painted on more than one since the last snapshot/Run).
  // Painted-in pixels become one 'add-brush' prompt (mode below) covering
  // every touched slice, erased pixels become one 'remove' prompt the same
  // way (see updateView's mode param) - NOT one prompt per slice: SAM2's
  // video predictor already supports adding several frames' exact masks to
  // the same tracking pass before propagating, so batching them into a
  // single request (see sam2_interactive.py's _propagate_multi) avoids
  // running a whole separate forward+backward propagation per slice, whose
  // tracked windows (MAX_FRAMES_TO_TRACK) mostly re-cover each other anyway
  // when the touched slices are close together. 'add-brush' is deliberately
  // its own mode, distinct from the plain 'add' that point/rectangle/
  // freehand ROI prompts use: those are meant to replace whatever's in their
  // drawn box (so the model can also correct/clear an existing bad mask
  // there), but a brush stroke is a deliberate, already-correct edit -
  // propagating it should only ADD the tracked voxels, never let SAM2's
  // padded margin clear other, unrelated same-class mask nearby that was
  // never touched by the brush.
  buildBrushParamsList() {
    const { brushSnapshot } = this.state;
    if (!brushSnapshot) {
      return [];
    }
    const { segIndex, mask: before, width, sliceLength } = brushSnapshot;
    const after = this.readClassVolumeMask(segIndex);
    if (!after || after.width !== width || after.sliceLength !== sliceLength) {
      return [];
    }

    const addedBySlice = new Map();
    const removedBySlice = new Map();
    for (let i = 0; i < after.mask.length; i++) {
      if (after.mask[i] === before[i]) {
        continue;
      }
      const sliceIndex = Math.floor(i / sliceLength);
      const local = i % sliceLength;
      const pixel = [local % width, Math.floor(local / width)];
      const bySlice = after.mask[i] ? addedBySlice : removedBySlice;
      if (!bySlice.has(sliceIndex)) {
        bySlice.set(sliceIndex, []);
      }
      bySlice.get(sliceIndex).push(pixel);
    }

    // One prompt per mode, carrying every touched slice's own mask -
    // xyBounds/zMin/zMax cover the union of all of them (see onRunInference,
    // which pads zMin/zMax by SAM2_MAX_FRAMES_TO_TRACK on each end the same
    // way it already does for a single-slice z).
    const toPrompt = (bySlice, mode) => {
      const sliceIndices = Array.from(bySlice.keys()).map(Number);
      const allPixels = sliceIndices.flatMap((sliceIndex) => bySlice.get(sliceIndex));
      const xs = allPixels.map((p) => p[0]);
      const ys = allPixels.map((p) => p[1]);
      return {
        kind: 'brush',
        mode,
        params: {
          brush_masks: sliceIndices.map((sliceIndex) => ({
            roi_slice: sliceIndex,
            brush_mask: bySlice.get(sliceIndex),
          })),
        },
        xyBounds: {
          xmin: Math.min(...xs) - BRUSH_NEIGHBORHOOD_MARGIN,
          ymin: Math.min(...ys) - BRUSH_NEIGHBORHOOD_MARGIN,
          xmax: Math.max(...xs) + BRUSH_NEIGHBORHOOD_MARGIN,
          ymax: Math.max(...ys) + BRUSH_NEIGHBORHOOD_MARGIN,
        },
        zMin: Math.min(...sliceIndices),
        zMax: Math.max(...sliceIndices),
      };
    };

    const prompts = [];
    if (addedBySlice.size) {
      prompts.push(toPrompt(addedBySlice, 'add-brush'));
    }
    if (removedBySlice.size) {
      prompts.push(toPrompt(removedBySlice, 'remove'));
    }
    return prompts;
  }

  // Exclude shapes (drawn in exclude mode - see onToggleExclude) aren't a
  // prompt of their own: they carve a region back out of whatever this
  // run's other prompt(s) produce, so they get attached to every prompt
  // built above rather than treated as an independent entry in that list.
  // Returns the shapes (for the generic post-hoc cut, every model/prompt
  // type) plus the point-only subset (for SAM2's own native negative-point
  // input, which only understands points, not boxes/polygons).
  buildExcludeShapes() {
    const worldToIndex = this.getWorldToIndex();
    const shapes = [];
    const points = [];

    for (const annotation of this.getToolAnnotations('ProbeMONAILabelExclude')) {
      const [x, y, z] = worldToIndex(annotation.data.handles.points[0]).map(Math.round);
      shapes.push({ type: 'point', xy: [x, y] });
      points.push([x, y, z]);
    }

    for (const annotation of this.getToolAnnotations('RectangleROIExclude')) {
      const corners = annotation.data.handles.points.map((pt) =>
        worldToIndex(pt).map(Math.round)
      );
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      shapes.push({
        type: 'box',
        start: [Math.min(...xs), Math.min(...ys)],
        end: [Math.max(...xs), Math.max(...ys)],
      });
    }

    for (const annotation of this.getToolAnnotations('PlanarFreehandROIExclude')) {
      const vertices = annotation.data.contour.polyline.map((pt) =>
        worldToIndex(pt).map(Math.round)
      );
      shapes.push({
        type: 'polygon',
        points: vertices.map((p) => [p[0], p[1]]),
      });
    }

    return { shapes, points };
  }

  onRunInference = async () => {
    const { currentModel, currentLabel } = this.state;
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

    // SAM2 only ever produces one binary mask per run and has no notion of
    // which of the 8 patterns it is - unlike nnU-Net, which classifies the
    // prompted region into all of them at once - so only the SAM2 model
    // needs a class picked before running.
    if (this.isSam2Model(model) && this.getModelLabels(model).length > 0 && !currentLabel) {
      this.notification.show({
        title: 'MONAI Label - ' + model,
        message: 'Select a class first',
        type: 'error',
        duration: 6000,
      });
      return;
    }

    // currentShape only tracks which tool is active for drawing right now -
    // Run itself should act on every shape drawn so far regardless of which
    // tool was active when each one was drawn, so gather all kinds.
    const allPrompts = [
      ...this.buildPointParamsList(),
      ...this.buildRectangleParamsList(),
      ...this.buildFreehandParamsList(),
      ...this.buildBrushParamsList(),
    ];

    const isSam2 = this.isSam2Model(model);
    // The brush prompt is a mask fed to SAM2's own video-propagation API
    // (add_new_mask) - nnU-Net has no comparable mask-prompt input, and a
    // hand-painted single-class mask doesn't fit its "classify everything
    // inside a region" interface anyway. A pending brush edit lingers
    // across shape/model switches on purpose (see buildBrushParamsList/
    // onSelectShape), so it can show up here even though this Run is for a
    // completely different, current shape - skip it rather than blocking
    // everything else this Run was actually meant to do.
    const prompts = isSam2 ? allPrompts : allPrompts.filter((p) => p.kind !== 'brush');
    const skippedBrush = allPrompts.length - prompts.length;

    if (!prompts.length) {
      this.notification.show({
        title: 'MONAI Label - ' + model,
        message: skippedBrush
          ? 'Brush painting only works with the SAM2 model - switch models to send it'
          : 'Draw a point, rectangle, freehand ROI, or brush stroke on the image first',
        type: 'error',
        duration: 6000,
      });
      return;
    }
    if (skippedBrush) {
      this.notification.show({
        title: 'MONAI Label - ' + model,
        message: 'Skipping a pending brush edit - switch to the SAM2 model to send it',
        type: 'warning',
        duration: 6000,
      });
    }

    const nid = this.notification.show({
      title: 'MONAI Label - ' + model,
      message:
        prompts.length > 1
          ? `Running Semi-Segmentation Inference (0/${prompts.length})...`
          : 'Running Semi-Segmentation Inference...',
      type: 'info',
      autoClose: false,
    });

    const config = this.props.onOptionsConfig();
    const label_names = info.modelLabelNames[model];
    const { shapes: excludeShapes, points: excludePoints } = this.buildExcludeShapes();
    this.props.setBusy(true);

    let failures = 0;
    let pointRunSucceeded = false;
    let brushRunSucceeded = false;
    let excludeUsed = false;
    // Everything below is wrapped so a thrown exception - e.g. updateView
    // failing to parse a malformed/error response body from the backend -
    // can't skip setBusy(false)/hideNotification: without this, the tab's
    // busy spinner and the "Running..." notification would stay stuck
    // forever even though the backend request itself already finished
    // (response.status !== 200 alone doesn't catch this - MonaiLabelClient's
    // axios wrapper never rejects, but a 200 response with an unexpected
    // body still throws downstream, in updateView, not here).
    try {
      for (let i = 0; i < prompts.length; i++) {
        const { kind, params: roi, xyBounds, z, zMin, zMax, mode } = prompts[i];
        // SAM2 always gets a z bound (its result is only ever real within
        // SAM2_MAX_FRAMES_TO_TRACK of the prompted slice(s)). nnU-Net's
        // result across the full depth is normally a real classification,
        // not a placeholder - EXCEPT for a point prompt, whose hull is
        // grown from one slice's local pixel similarity and which nnU-Net
        // therefore only classifies within a small z window around it too
        // (see POINT_Z_MARGIN/nnunet.py's Z_MIN_SIZE). A brush prompt
        // carries zMin/zMax (the union of every slice it touched) instead
        // of a single z - matches sam2_interactive.py's _propagate_multi,
        // which tracks SAM2_MAX_FRAMES_TO_TRACK past each end of that same
        // range rather than around one slice.
        let bounds = xyBounds;
        if (kind === 'brush' && zMin != null && zMax != null) {
          bounds = { ...xyBounds, zmin: zMin - SAM2_MAX_FRAMES_TO_TRACK, zmax: zMax + SAM2_MAX_FRAMES_TO_TRACK };
        } else if (z != null) {
          if (isSam2) {
            bounds = { ...xyBounds, zmin: z - SAM2_MAX_FRAMES_TO_TRACK, zmax: z + SAM2_MAX_FRAMES_TO_TRACK };
          } else if (kind === 'point') {
            bounds = { ...xyBounds, zmin: z - POINT_Z_MARGIN, zmax: z + POINT_Z_MARGIN };
          }
        }
        const params = {
          ...(config && config.infer && config.infer[model] ? config.infer[model] : {}),
          ...(currentLabel ? { label: currentLabel } : {}),
          ...roi,
          // exclude_shapes: guaranteed post-hoc cut, every model/prompt type.
          // background: SAM2's own native negative-point input (points
          // only) - harmless to also send when the model is nnU-Net, which
          // ignores it.
          ...(excludeShapes.length ? { exclude_shapes: excludeShapes } : {}),
          ...(excludePoints.length ? { background: excludePoints } : {}),
        };

        // eslint-disable-next-line no-await-in-loop
        const response = await this.props
          .client()
          .infer(model, displaySet.SeriesInstanceUID, params);

        if (response.status !== 200) {
          failures++;
          continue;
        }

        if (kind === 'point') {
          pointRunSucceeded = true;
        }
        if (kind === 'brush') {
          brushRunSucceeded = true;
        }
        if (excludeShapes.length) {
          excludeUsed = true;
        }

        // override=true merges this run's mask into the existing labelmap
        // (only voxels currently 0 or already this class get touched)
        // instead of replacing the whole volume - so classes/regions from
        // earlier runs stay visible. xyBounds further restricts that merge
        // to this run's own drawn region, so separate shapes never clobber
        // each other. mode ('remove' for a brush-erase prompt, 'add-brush'
        // for a brush-paint prompt, 'add' for every other prompt type) tells
        // it whether to merge this class in, carve it back out, or
        // (add-brush) merge in additively without clearing anything else
        // nearby.
        // eslint-disable-next-line no-await-in-loop
        await this.props.updateView(response, model, label_names, true, false, -1, bounds, mode);
      }

      // Points are consumed once used - clear them so the next points
      // placed start a fresh outline instead of silently combining with
      // these.
      if (pointRunSucceeded) {
        this.clearPointAnnotations();
      }
      if (excludeUsed) {
        this.clearExcludeAnnotations();
      }
      // Re-arm the brush baseline against the now-updated segmentation
      // (which just gained/lost whatever SAM2 propagated), so the next
      // stroke diffs cleanly instead of against the pre-propagation state.
      if (brushRunSucceeded) {
        this.snapshotBrush();
      }

      hideNotification(nid, this.notification);

      if (failures === prompts.length) {
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
        message:
          failures > 0
            ? `Running Semi-Segmentation Inference - ${prompts.length - failures}/${prompts.length} succeeded`
            : 'Running Semi-Segmentation Inference - Successful',
        type: failures > 0 ? 'warning' : 'success',
        duration: 4000,
      });
    } catch (e) {
      console.error('Semi-Segmentation inference failed', e);
      hideNotification(nid, this.notification);
      this.notification.show({
        title: 'MONAI Label - ' + model,
        message: 'Failed to Run Semi-Segmentation Inference',
        type: 'error',
        duration: 6000,
      });
    } finally {
      this.props.setBusy(false);
    }
  };

  render() {
    const models = this.getModels();
    const display = models.length > 0 ? 'block' : 'none';
    const { currentShape, currentLabel, excludeMode, brushSize } = this.state;
    // ModelSelector defaults to the first model until the user changes it
    // without telling this component - mirror that default here too.
    const model = this.state.currentModel || models[0] || null;
    const labels = this.getModelLabels(model);
    const segInfo = this.segmentInfo();

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
              className={`annotationToolButton ${currentShape === 'point' ? 'active' : ''}`}
              title="Point"
              onClick={() => this.onSelectShape('point')}
            >
              <Icon name="tool-probe" width="16px" height="16px" />
            </button>
            <button
              className={`annotationToolButton ${currentShape === 'rectangle' ? 'active' : ''}`}
              title="Rectangle"
              onClick={() => this.onSelectShape('rectangle')}
            >
              <Icon name="tool-rectangle" width="16px" height="16px" />
            </button>
            <button
              className={`annotationToolButton ${currentShape === 'freehand' ? 'active' : ''}`}
              title="Freehand"
              onClick={() => this.onSelectShape('freehand')}
            >
              <Icon name="icon-tool-freehand-roi" width="16px" height="16px" />
            </button>
            <button
              className={`annotationToolButton ${currentShape === 'brush' ? 'active' : ''}`}
              title="Brush - paints/erases the selected class directly, then SAM2 propagates the edit to other slices on Run"
              onClick={() => this.onSelectShape('brush')}
            >
              <Icon name="icon-tool-brush" width="16px" height="16px" />
            </button>
            <button
              className={`annotationToolButton excludeToolButton ${excludeMode ? 'active' : ''}`}
              title={
                currentShape === 'brush'
                  ? excludeMode
                    ? 'Exclude mode ON - the brush now erases the selected class'
                    : 'Exclude mode - toggle on to erase the selected class with the brush instead of painting it'
                  : excludeMode
                    ? 'Exclude mode ON - the shape tools above now remove from the result'
                    : 'Exclude mode - toggle on, then draw with the shape tools above to remove from the result'
              }
              onClick={this.onToggleExclude}
            >
              <ExcludeIcon />
            </button>
            <div className="annotationToolDivider" />
            <button
              className="annotationToolButton"
              title="Undo last annotation"
              onClick={this.onUndo}
            >
              <UndoIcon />
            </button>
            <button
              className="annotationToolButton"
              title="Redo annotation"
              onClick={this.onRedo}
            >
              <RedoIcon />
            </button>
            <div className="annotationToolDivider" />
            <button
              className="annotationToolButton"
              title="Reset all segments"
              onClick={this.onReset}
            >
              <ResetIcon />
            </button>
          </div>
          {currentShape === 'brush' && (
            <div className="brushSizeRow">
              <span className="brushSizeLabel">Brush Radius</span>
              <input
                type="range"
                min={MIN_BRUSH_SIZE}
                max={MAX_BRUSH_SIZE}
                step={1}
                value={brushSize}
                onChange={this.onBrushSizeChange}
                title={`${brushSize}mm radius`}
                style={
                  {
                    '--pct': `${((brushSize - MIN_BRUSH_SIZE) / (MAX_BRUSH_SIZE - MIN_BRUSH_SIZE)) * 100}%`,
                  } as React.CSSProperties
                }
              />
              <span className="brushSizeValue">{brushSize}mm</span>
            </div>
          )}
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
                  {currentShape === 'brush'
                    ? 'Pick a class below, then paint (or, with Exclude on, erase) it directly on the image. Run sends that edit to SAM2 to propagate across the rest of the slices.'
                    : 'Pick a tool above, draw on the image, then run inference.'}{' '}
                  {this.isSam2Model(model)
                    ? 'SAM2 traces one object per run - pick a class below first to say which pattern it is.'
                    : 'All classes found in that region are segmented at once - check a class below just to highlight it.'}
                </p>
              </div>
            }
          />
          {labels.length > 0 && (
            <div className="optionsTableContainer">
              <hr />
              <p>Class:</p>
              <hr />
              <div className="bodyTableContainer">
                <table className="optionsTable">
                  <tbody>
                    {labels.map((label) => (
                      <tr
                        key={label}
                        className="clickable-row"
                        onClick={() => this.onSelectLabel(label)}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={currentLabel === label}
                            readOnly
                          />
                        </td>
                        <td>
                          <span
                            className="segColor"
                            style={{
                              backgroundColor: this.segColorToRgb(segInfo[label]),
                            }}
                          />
                        </td>
                        <td>{label}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
}
