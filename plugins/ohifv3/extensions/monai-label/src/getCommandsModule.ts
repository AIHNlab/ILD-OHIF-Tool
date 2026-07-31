import annotationHistory from './utils/AnnotationHistory';

export default function getCommandsModule({ servicesManager }) {
  const { uiNotificationService } = servicesManager.services;

  const actions = {
    setToolActive: ({ toolName }) => {
      uiNotificationService.show({
        title: 'MONAI Label probe',
        message: 'MONAI Label Probe Activated.',
        type: 'info',
        duration: 3000,
      });
    },
    undoMonaiAnnotation: () => {
      annotationHistory.undo();
    },
    redoMonaiAnnotation: () => {
      annotationHistory.redo();
    },
  };

  const definitions = {
    setToolActive: {
      commandFn: actions.setToolActive,
    },
    undoMonaiAnnotation: {
      commandFn: actions.undoMonaiAnnotation,
    },
    redoMonaiAnnotation: {
      commandFn: actions.redoMonaiAnnotation,
    },
  };

  return {
    actions,
    definitions,
    defaultContext: 'MONAILabel',
  };
}
