import { addTool, RectangleROITool, PlanarFreehandROITool } from '@cornerstonejs/tools';
import { Types } from '@ohif/core';
import ProbeMONAILabelTool from './tools/ProbeMONAILabelTool';
import './utils/AnnotationHistory';

/**
 * @param {object} configuration
 */
export default function init({
  servicesManager,
  configuration = {},
}: Types.Extensions.ExtensionParams): void {
  addTool(ProbeMONAILabelTool);
  addTool(RectangleROITool);
  addTool(PlanarFreehandROITool);
}
