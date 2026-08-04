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

import { getEnabledElement } from '@cornerstonejs/core';
import { ProbeTool, annotation, drawing, utilities } from '@cornerstonejs/tools';
import { vec2 } from 'gl-matrix';

const { getAnnotations } = annotation.state;
const { lineSegment } = utilities.math;

// Radius (canvas px) around each vertex reserved for getHandleNearImagePoint
// (select/delete just that one point) - isPointNearTool below must yield to
// it near vertices so a click exactly on a point doesn't get swallowed by
// the whole-group edge match. Keep in sync with the mirrored check in
// Viewers' extensions/cornerstone/src/commandsModule.ts deleteMeasurement.
const VERTEX_EXCLUSION_RADIUS = 10;

export default class ProbeMONAILabelTool extends ProbeTool {
  static toolName = 'ProbeMONAILabel';

  constructor(
    toolProps = {},
    defaultToolProps = {
      configuration: {
        customColor: undefined,
      },
    }
  ) {
    super(toolProps, defaultToolProps);
  }

  /**
   * The base ProbeTool always returns false here since a single point has
   * no "edge" - but this tool draws a connecting outline across ALL of its
   * points (see renderAnnotation), so hovering that outline should glow the
   * whole point set, the same way hovering a Rectangle/Freehand edge glows
   * the whole shape. Ignores which specific annotation was passed in and
   * re-checks the full group, so every point highlights together.
   *
   * Excludes a radius around each vertex so hovering/clicking a point still
   * resolves to just that one point via getHandleNearImagePoint, instead of
   * always matching the whole-group edge check first (cornerstone's nearby-
   * annotation lookup checks isPointNearTool before getHandleNearImagePoint,
   * and a vertex is trivially "near" its own adjacent edges).
   */
  isPointNearTool = (element, _annotation, canvasCoords, proximity = 6): boolean => {
    const enabledElement = getEnabledElement(element);
    if (!enabledElement) {
      return false;
    }
    const { viewport } = enabledElement;
    const annotations = getAnnotations(this.getToolName(), element);
    if (!annotations || annotations.length < 2) {
      return false;
    }

    const canvasPoints = annotations.map((a) =>
      viewport.worldToCanvas((a as ProbeAnnotation).data.handles.points[0])
    );

    for (let i = 0; i < canvasPoints.length; i++) {
      const start = canvasPoints[i];
      const end = canvasPoints[(i + 1) % canvasPoints.length];
      if (
        vec2.distance(canvasCoords, start) < VERTEX_EXCLUSION_RADIUS ||
        vec2.distance(canvasCoords, end) < VERTEX_EXCLUSION_RADIUS
      ) {
        continue;
      }
      if (lineSegment.distanceToPoint(start, end, canvasCoords) <= proximity) {
        return true;
      }
    }
    return false;
  };

  renderAnnotation = (enabledElement, svgDrawingHelper): boolean => {
    let renderStatus = false;
    const { viewport } = enabledElement;
    const { element } = viewport;

    let annotations = getAnnotations(this.getToolName(), element);

    if (!annotations?.length) {
      return renderStatus;
    }

    annotations = this.filterInteractableAnnotationsForElement(
      element,
      annotations
    );

    if (!annotations?.length) {
      return renderStatus;
    }

    const targetId = this.getTargetId(viewport);
    const renderingEngine = viewport.getRenderingEngine();

    const styleSpecifier: StyleSpecifier = {
      toolGroupId: this.toolGroupId,
      toolName: this.getToolName(),
      viewportId: enabledElement.viewport.id,
    };

    const edgeCanvasCoordinates = [];
    let edgeColor;

    for (let i = 0; i < annotations.length; i++) {
      const annotation = annotations[i] as ProbeAnnotation;
      const annotationUID = annotation.annotationUID;
      const data = annotation.data;
      const point = data.handles.points[0];
      const canvasCoordinates = viewport.worldToCanvas(point);

      styleSpecifier.annotationUID = annotationUID;

      const color =
        this.configuration?.customColor ??
        this.getStyle('color', styleSpecifier, annotation);

      // If rendering engine has been destroyed while rendering
      if (!viewport.getRenderingEngine()) {
        console.warn('Rendering Engine has been destroyed');
        return renderStatus;
      }

      const handleGroupUID = '0';

      drawing.drawHandles(
        svgDrawingHelper,
        annotationUID,
        handleGroupUID,
        [canvasCoordinates],
        { color }
      );

      edgeCanvasCoordinates.push(canvasCoordinates);
      edgeColor = edgeColor ?? color;

      renderStatus = true;
    }

    // Connect the picked points with straight edges so the region they
    // outline is visible as it's being built, matching Rectangle/Freehand.
    if (edgeCanvasCoordinates.length > 1) {
      drawing.drawPolyline(
        svgDrawingHelper,
        'roiPoints',
        'pointRegionOutline',
        edgeCanvasCoordinates,
        { color: edgeColor, width: 1, closePath: true }
      );
    }

    return renderStatus;
  };
}
