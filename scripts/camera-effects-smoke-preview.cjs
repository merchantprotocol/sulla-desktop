// SPDX-License-Identifier: GPL-2.0-or-later
const assert = require('node:assert/strict');
const { createApp, reactive, shallowRef, ref, nextTick } = require('vue');
const PreviewHarness = require('./PreviewHarness').default;

// Production preview mounting is isolated from native inference/recording smoke.
class PreviewBindingsSmoke {
  constructor(createCanvas) { this.canvas = createCanvas; }

  async run(shared) {
    // risk: recording-preview-integrity — mount actual SFC videos and parent wiring;
    // the processed camera object below is the same object handed to useRecorder.
    const screen = this.canvas(32, 32).captureStream(1);
    const replacement = this.canvas(32, 32).captureStream(1);
    const element = document.createElement('div');
    document.body.appendChild(element);
    const cameraSource = { id: 'cam', type: 'camera', name: 'Synthetic camera', on: true, isVideo: true };
    const screenSource = { id: 'screen', type: 'screen', name: 'Synthetic screen', on: true, isVideo: true };
    const state = {
      sources: reactive([cameraSource]),
      assign: reactive({ primary: '', pip: '' }),
      mediaSources: { cameraStream: shallowRef(shared), screenStream: shallowRef(null) },
      currentLayout: ref('camonly'),
    };
    const app = createApp(PreviewHarness, { state });
    const vm = app.mount(element);
    const settled = async() => { await nextTick(); await nextTick(); };
    const identity = (selector, expected, reason) => assert.equal(element.querySelector(selector).srcObject, expected, reason);
    try {
      vm.autoAssign(); vm.updateStreamAssignments();
      await settled();
      identity('.fullscreen-camera video', shared, 'PREVIEW_PRIMARY_SENTINEL: single camera fullscreen lost recorder stream');
      assert.equal(state.assign.pip, '');
      // Publish screen, then change assignments WITHOUT stream publication.
      state.sources.push(screenSource);
      state.mediaSources.screenStream.value = screen;
      vm.autoAssign(); vm.updateStreamAssignments();
      await vm.selectLayout('pip');
      await settled();
      identity('.screen-preview video', shared, 'Camera primary in PiP');
      identity('.cam-bubble video', screen, 'Screen secondary in PiP');
      vm.swapAssignments();
      await settled();
      identity('.screen-preview video', screen, 'ASSIGNMENT_SENTINEL: swapped primary stale');
      identity('.cam-bubble video', shared, 'ASSIGNMENT_SENTINEL: swapped PiP stale');
      await vm.selectLayout('sidebyside');
      await settled();
      identity('.sbs-camera video', shared, 'Side-by-side secondary camera');
      vm.swapAssignments();
      await settled();
      identity('.screen-preview video', shared, 'Side-by-side swapped camera primary');
      identity('.sbs-camera video', screen, 'Side-by-side swapped screen secondary');
      vm.swapAssignments();
      await vm.selectLayout('camonly');
      await settled();
      identity('.fullscreen-camera video', shared, 'Layout-only camonly transition stale');
      await vm.selectLayout('pip'); await settled();
      identity('.screen-preview video', shared, 'Camera primary after layout-only return');
      identity('.cam-bubble video', screen, 'Layout-only return lost distinct screen slot');
      await vm.selectLayout('camonly'); await settled();
      // Real published processed camera replacement and release, independent of assignments.
      state.mediaSources.cameraStream.value = replacement;
      await settled();
      identity('.fullscreen-camera video', replacement, 'Camera replacement stale');
      state.mediaSources.cameraStream.value = null;
      await settled();
      identity('.fullscreen-camera video', null, 'Released camera retained by fullscreen');
      state.mediaSources.cameraStream.value = shared;
      state.assign.primary = 'screen'; state.assign.pip = 'cam';
      await vm.selectLayout('pip'); await settled();
      state.mediaSources.cameraStream.value = replacement;
      await settled();
      identity('.cam-bubble video', replacement, 'PiP camera replacement stale');
      identity('.sbs-camera video', replacement, 'Secondary camera replacement stale');
      state.mediaSources.screenStream.value = replacement;
      await settled();
      identity('.screen-preview video', replacement, 'Screen replacement stale');
      state.mediaSources.cameraStream.value = null;
      await settled();
      identity('.cam-bubble video', null, 'Released camera retained by bubble');
      identity('.sbs-camera video', null, 'Released camera retained by secondary');
      state.mediaSources.screenStream.value = null;
      await settled();
      identity('.screen-preview video', null, 'Released screen retained');
      state.mediaSources.cameraStream.value = shared;
      state.sources[0].on = false;
      await settled();
      identity('.cam-bubble video', null, 'Disabled source still displayed');
      assert.equal(shared.getVideoTracks()[0].readyState, 'live', 'Preview took camera ownership');
    } finally {
      app.unmount(); element.remove();
      screen.getTracks().forEach(track => track.stop());
      replacement.getTracks().forEach(track => track.stop());
    }
  }

}
module.exports = { PreviewBindingsSmoke };
