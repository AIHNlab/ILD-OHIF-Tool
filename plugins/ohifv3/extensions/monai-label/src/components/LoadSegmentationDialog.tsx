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
import { Dialog, ButtonEnums } from '@ohif/ui';

function formatSavedAt(info) {
  if (!info?.ts) {
    return 'Unknown time';
  }
  return new Date(info.ts * 1000).toLocaleString();
}

const TrashIcon = () => (
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

// First modal: a picker over every saved segmentation for this image
// (model/date/class-count at a glance). Selecting one dismisses this and
// opens a second modal with the full details before actually loading -
// nothing is applied until the user explicitly confirms there. onDeleteSave
// (save) => Promise<boolean> does the actual backend delete - resolving
// true removes the row from this list in place, false/rejection leaves it
// (the caller is expected to have already shown its own error notification).
function loadSegmentationDialog(uiDialogService, saves, onConfirmLoad, onDeleteSave) {
  const listDialogId = 'monai-label-load-list';

  const showDetails = (save) => {
    const detailsDialogId = 'monai-label-load-details';
    const classes = save.info?.classes || [];

    uiDialogService.create({
      id: detailsDialogId,
      centralize: true,
      isDraggable: false,
      showOverlay: true,
      content: Dialog,
      contentProps: {
        title: 'Segmentation Details',
        noCloseButton: true,
        onClose: () => uiDialogService.dismiss({ id: detailsDialogId }),
        actions: [
          { id: 'cancel', text: 'Cancel', type: ButtonEnums.type.secondary },
          { id: 'load', text: 'Load', type: ButtonEnums.type.primary },
        ],
        onSubmit: ({ action }) => {
          uiDialogService.dismiss({ id: detailsDialogId });
          if (action.id === 'load') {
            onConfirmLoad(save.tag);
          }
        },
        body: () => (
          <div className="bg-primary-dark p-4 text-white">
            <table>
              <tbody>
                <tr>
                  <td className="pr-4 align-top text-gray-400">Model:</td>
                  <td>{save.info?.model || 'Unknown'}</td>
                </tr>
                <tr>
                  <td className="pr-4 align-top text-gray-400">Saved:</td>
                  <td>{formatSavedAt(save.info)}</td>
                </tr>
                <tr>
                  <td className="pr-4 align-top text-gray-400">Classes:</td>
                  <td>{classes.length ? classes.join(', ') : 'None recorded'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ),
      },
    });
  };

  // Re-creating the list dialog (rather than mutating in place) is what
  // lets a delete remove its row immediately without closing/reopening the
  // whole modal - currentSaves is threaded through instead of closing over
  // the outer saves so a delete is reflected right away. Explicitly
  // dismissing any existing instance of this same dialog id first avoids
  // ending up with two mounted at once (React warns about the id being
  // reused as a duplicate key) when this is called again after a delete.
  const showList = (currentSaves) => {
    uiDialogService.dismiss({ id: listDialogId });
    uiDialogService.create({
      id: listDialogId,
      centralize: true,
      isDraggable: false,
      showOverlay: true,
      content: Dialog,
      contentProps: {
        title: 'Load Segmentation',
        noCloseButton: true,
        onClose: () => uiDialogService.dismiss({ id: listDialogId }),
        actions: [{ id: 'close', text: 'Close', type: ButtonEnums.type.secondary }],
        onSubmit: () => uiDialogService.dismiss({ id: listDialogId }),
        body: () => (
          <div className="bg-primary-dark max-h-[50vh] w-[420px] overflow-y-auto p-4 text-white">
            {!currentSaves.length && <p>No saved segmentations found for this image.</p>}
            {currentSaves.map((save) => {
              const classes = save.info?.classes || [];
              return (
                <div
                  key={save.tag}
                  className="mb-2 flex items-center gap-2 rounded border border-gray-600 p-2 hover:bg-gray-700"
                >
                  <div
                    className="flex-1 cursor-pointer"
                    onClick={() => {
                      uiDialogService.dismiss({ id: listDialogId });
                      showDetails(save);
                    }}
                  >
                    <div>{formatSavedAt(save.info)}</div>
                    <div className="text-sm text-gray-400">
                      {save.info?.model || 'Unknown model'} &middot; {classes.length} class
                      {classes.length === 1 ? '' : 'es'}
                    </div>
                  </div>
                  <button
                    className="shrink-0 text-gray-400 hover:text-red-500"
                    title="Delete this saved segmentation"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (
                        !window.confirm(
                          `Delete the segmentation saved ${formatSavedAt(save.info)}? This cannot be undone.`
                        )
                      ) {
                        return;
                      }
                      const deleted = await onDeleteSave(save);
                      if (deleted) {
                        showList(currentSaves.filter((s) => s.tag !== save.tag));
                      }
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              );
            })}
          </div>
        ),
      },
    });
  };

  showList(saves);
}

export default loadSegmentationDialog;
