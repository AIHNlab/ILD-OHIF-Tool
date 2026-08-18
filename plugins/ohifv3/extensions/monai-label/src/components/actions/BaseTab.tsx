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

import { Component } from 'react';
import PropTypes from 'prop-types';
import { eventTarget } from '@cornerstonejs/core';
import { Enums as CornerstoneToolsEnums } from '@cornerstonejs/tools';

import './BaseTab.css';
import { UIModalService, UINotificationService } from '@ohif/core';
import { currentSegmentsInfo } from '../../utils/SegUtils';

export default class BaseTab extends Component {
  static propTypes = {
    tabIndex: PropTypes.number,
    info: PropTypes.any,
    client: PropTypes.func,
    updateView: PropTypes.func,
    setBusy: PropTypes.func,
    isBusy: PropTypes.bool,
    onSelectActionTab: PropTypes.func,
    onOptionsConfig: PropTypes.func,
    getActiveViewportInfo: PropTypes.func,
    servicesManager: PropTypes.any,
    commandsManager: PropTypes.any,
  };

  notification: any;
  uiModelService: any;
  tabId: string;
  private segmentInfoPoll: ReturnType<typeof setInterval> | null = null;

  constructor(props) {
    super(props);
    this.notification = new UINotificationService();
    this.uiModelService = new UIModalService();
    this.tabId = 'tab-' + this.props.tabIndex;
  }

  // Whichever tab is shown by default at panel load (currently
  // Auto-Segmentation) can render its very first pass before segments
  // finish being registered/colored - segmentInfo() would then return {}
  // forever after, since nothing about this component's own props/state
  // ever changes again to trigger a re-render. Re-rendering whenever
  // cornerstone3D reports the segmentation's metadata (segment list,
  // colors, labels) changed picks up real colors as soon as they exist,
  // regardless of which tab happened to render first.
  componentDidMount() {
    eventTarget.addEventListener(
      CornerstoneToolsEnums.Events.SEGMENTATION_MODIFIED,
      this.onSegmentationMetadataModified
    );
    // Belt-and-suspenders: rather than betting everything on that one
    // event firing at exactly the right moment (initial segment/color
    // setup could go through a different path than later edits do), just
    // re-render a few times shortly after mount regardless. Cheap, bounded,
    // and self-cancels once it's had its chance.
    let attempts = 0;
    this.segmentInfoPoll = setInterval(() => {
      attempts += 1;
      this.forceUpdate();
      if (attempts >= 10 && this.segmentInfoPoll) {
        clearInterval(this.segmentInfoPoll);
        this.segmentInfoPoll = null;
      }
    }, 300);
  }

  componentWillUnmount() {
    eventTarget.removeEventListener(
      CornerstoneToolsEnums.Events.SEGMENTATION_MODIFIED,
      this.onSegmentationMetadataModified
    );
    if (this.segmentInfoPoll) {
      clearInterval(this.segmentInfoPoll);
      this.segmentInfoPoll = null;
    }
  }

  onSegmentationMetadataModified = () => {
    this.forceUpdate();
  };

  onSelectActionTab = (evt) => {
    this.props.onSelectActionTab(evt.currentTarget.value);
  };
  onEnterActionTab = () => {};
  onLeaveActionTab = () => {};
  onSegmentCreated = (id) => {};
  onSegmentUpdated = (id) => {};
  onSegmentDeleted = (id) => {};
  onSegmentSelected = (id) => {};
  onSelectModel = (model) => {};

  segmentInfo = () => {
    // servicesManager can be momentarily undefined on an early/transient
    // render (e.g. right after a hot reload, before the panel has finished
    // wiring props down) - render()s that call this unconditionally
    // (AutoSegmentation/SemiSegmentation/ClassPrompts) shouldn't crash the
    // whole tab over it, just show no colors yet until the next render.
    const segmentationService = this.props.servicesManager?.services?.segmentationService;
    return segmentationService ? currentSegmentsInfo(segmentationService).info : {};
  };
}
