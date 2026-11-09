// SPDX-License-Identifier: GPL-2.0-or-later
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { ipcRenderer } = require('electron');
const { FrameCompositor, PersonFraming } = require('./FrameCompositor');
const { OfflinePersonInference, VisionInitializationGate } = require('./PersonInference');
const { createApp, h } = require('vue');
const { CameraEffectsComposition, cameraEffectsKey } = require('./CameraEffectsComposition');
const { useMediaSources } = require('./useMediaSources');
const { useRecorder } = require('./useRecorder');
const { BrowserFrameSurface } = require('./VideoEffectService');
const nativeRequire = require('node:module').createRequire(process.resourcesPath + '/ce1-native.cjs');

class CameraEffectsRendererSmoke {
  surfaces = [];

  layer() {
    const canvas = this.canvas(1, 1);
    this.surfaces.push(canvas);
    return canvas;
  }
  canvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    return canvas;
  }

  pixels() {
    // risk: recorded-image-integrity — background must not shift under the person mask.
    const source = this.canvas(256, 160);
    const context = source.getContext('2d');
    const image = context.createImageData(256, 160);
    for (let y = 0; y < 160; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      image.data.set([x, y, 32, 255], i);
    }
    context.putImageData(image, 0, 0);
    context.fillStyle = 'black'; context.fillRect(210, 0, 46, 160);
    const output = this.canvas(256, 160);
    const compositor = new FrameCompositor(new PersonFraming(), () => this.layer());
    const categories = new Uint8Array(256 * 160);
    for (let y = 0; y < 160; y++) categories.fill(4, y * 256 + 60, y * 256 + 84);
    const mask = { width: 256, height: 160, categories };
    for (const strength of [0.25, 1]) {
      compositor.draw(source, output, mask, { autoFrame: false, soften: 0, backgroundBlur: strength }, 0);
      const pixels = output.getContext('2d').getImageData(0, 0, 256, 160).data;
      for (const x of [64, 80, 128, 160, 176]) {
        assert.ok(Math.abs(pixels[(80 * 256 + x) * 4] - x) <= 3, 'Scene coordinates changed at ' + x);
      }
      for (const offset of [0, 255, 159 * 256, 160 * 256 - 1]) assert.equal(pixels[offset * 4 + 3], 255, 'Transparent blur edge');
      assert.ok(pixels[(80 * 256 + 230) * 4] < 12, 'High contrast background moved');
    }
    const reference = output.getContext('2d').getImageData(0, 0, 256, 160);
    const framed = new FrameCompositor(new PersonFraming(), () => this.layer());
    framed.draw(source, output, mask, { autoFrame: true, soften: 0, backgroundBlur: 1 }, 0);
    // Off-center mask centers at x=72; crop clamps at x=0. Same 0.8 crop in both axes.
    for (const x of [60, 90, 150, 200]) {
      const expectedX = Math.floor((x + 0.5) * 0.8);
      const actual = output.getContext('2d').getImageData(x, 80, 1, 1).data;
      const expected = reference.data[(80 * 256 + expectedX) * 4];
      assert.ok(Math.abs(actual[0] - expected) <= 3, 'Framed foreground/background coordinates changed at ' + x + ': ' + actual[0] + ' vs ' + expected);
    }
    // Use a fresh tracker to test centered no-subject crop without prior tracking state.
    const centered = new FrameCompositor(new PersonFraming(), () => this.layer());
    // Reusing layers must clear mask alpha, not retain a previous person.
    categories.fill(0);
    centered.draw(source, output, mask, { autoFrame: true, soften: 0, backgroundBlur: 0 }, 100);
    assert.ok(Math.abs(output.getContext('2d').getImageData(0, 80, 1, 1).data[0] - 26) <= 2, 'Crop/source coordinate mismatch');
    assert.throws(() => compositor.draw(source, output, { ...mask, width: 0 }, { autoFrame: true, soften: 0, backgroundBlur: 1 }, 200));
    categories[0] = 255;
    assert.throws(() => compositor.draw(source, output, mask, { autoFrame: true, soften: 0, backgroundBlur: 1 }, 200));
    categories.fill(0);
    context.fillStyle = 'black'; context.fillRect(0, 0, 256, 160);
    context.fillStyle = 'white'; context.fillRect(80, 80, 1, 1); context.fillRect(176, 80, 1, 1);
    categories[80 * 256 + 80] = 3; categories[80 * 256 + 176] = 4;
    compositor.draw(source, output, mask, { autoFrame: false, soften: 1, backgroundBlur: 0 }, 300);
    assert.ok(output.getContext('2d').getImageData(80, 80, 1, 1).data[0] < 220, 'Face was not softened');
    assert.equal(output.getContext('2d').getImageData(176, 80, 1, 1).data[0], 255, 'Clothing was softened');
    framed.close();
    centered.close();
    return { compositor, source, output };
  }

  async composition(resources) {
    // risk: saved-video-integrity — actual composition + composables + disk writer, no devices.
    const source = this.canvas(1920, 1080);
    const paint = () => {
      const context = source.getContext('2d');
      context.fillStyle = 'rgb(0,255,0)'; context.fillRect(0, 0, 1920, 1080);
      context.fillStyle = 'rgb(255,0,0)'; context.fillRect(0, 0, 144, 1080); context.fillRect(1776, 0, 144, 1080);
    };
    paint();
    const raw = source.captureStream(30);
    window.__ce1Raw = raw; // Mutation-only boundary, never shipped in application.
    const timer = setInterval(paint, 33);
    const originalAcquire = navigator.mediaDevices.getUserMedia;
    const originalEnumerate = navigator.mediaDevices.enumerateDevices;
    navigator.mediaDevices.getUserMedia = async() => raw;
    navigator.mediaDevices.enumerateDevices = async() => [];
    let media; let recorder; let loads = 0; let mounted; let recording = false;
    const preview = document.createElement('video');
    preview.muted = true;
    const element = document.createElement('div'); document.body.appendChild(element);
    try {
      // Deterministic synthetic inference boundary; real offline model is exercised separately below.
      const runtime = {
        FilesetResolver: { forVisionTasks: async() => ({}) },
        ImageSegmenter: { createFromOptions: async() => ({
          segmentForVideo(frame) {
            assert.equal(frame.width, 512, 'Raw inference input was not bounded');
            assert.equal(frame.height, 288);
            return { categoryMask: { width: 256, height: 144, getAsUint8Array: () => new Uint8Array(256 * 144) }, close() {} };
          }, close() {},
        }) },
      };
      const composition = new CameraEffectsComposition(require('path').dirname(resources), () => { loads++; return runtime; }, async() => new Uint8Array(), document, window, error => { throw error; });
      mounted = createApp({ setup() { media = useMediaSources(); recorder = useRecorder(); return () => h('div'); } });
      mounted.provide(cameraEffectsKey, composition.effects);
      mounted.mount(element);
      await media.acquireCamera();
      assert.equal(loads, 0, 'Default-off loaded a model');
      assert.equal(media.cameraStream.value, raw, 'Off must preserve raw');
      await media.camera.setOptions({ autoFrame: true, soften: 0, backgroundBlur: 0 });
      assert.equal(loads, 1, 'Actual composition did not initialize model');
      const shared = media.cameraStream.value;
      assert.notEqual(shared, raw);
      assert.equal(await media.camera.beginRecording(), shared);
      preview.srcObject = shared; await preview.play();
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.throws(() => media.camera.setOptions({ autoFrame: false, soften: 0, backgroundBlur: 0 }), /Stop recording/);
      await assert.rejects(media.switchCamera('synthetic-other-device'), /Stop recording/);
      await assert.rejects(media.setCameraQuality('480p'), /Stop recording/);
      await assert.rejects(media.releaseCamera(), /Stop recording/);
      const session = recorder.startSession([{ id: 'cam', type: 'camera', stream: shared, quality: '720p' }]);
      assert.ok(session, recorder.error.value);
      recording = true;
      const filename = require('path').join(recorder.getSessionDir(), 'camera.webm');
      await new Promise(resolve => setTimeout(resolve, 650));
      assert.equal(media.cameraStream.value, shared, 'Recording output replaced');
      await recorder.stopSession(); recording = false;
      media.camera.endRecording();
      const saved = await readFile(filename);
      assert.ok(saved.length > 100, 'No encoded file saved');
      const playback = document.createElement('video');
      const url = URL.createObjectURL(new Blob([saved], { type: 'video/webm' }));
      try {
        await new Promise((resolve, reject) => { playback.onloadeddata = resolve; playback.onerror = () => reject(new Error('Saved WebM did not decode')); playback.src = url; playback.load(); });
        assert.equal(playback.videoWidth, 1280);
        assert.equal(playback.videoHeight, 720);
        const decoded = this.canvas(1280, 720);
        decoded.getContext('2d').drawImage(playback, 0, 0);
        const edge = decoded.getContext('2d').getImageData(4, 360, 1, 1).data;
        assert.ok(edge[1] > 180 && edge[0] < 70, 'Saved video contains raw red edge, not processed framing: ' + [...edge]);
        decoded.getContext('2d').drawImage(preview, 0, 0);
        const live = decoded.getContext('2d').getImageData(4, 360, 1, 1).data;
        assert.ok(live[1] > 180 && live[0] < 70, 'Preview and saved video differ');
      } finally { playback.src = ''; URL.revokeObjectURL(url); }
      await media.camera.setOptions({ autoFrame: false, soften: 0, backgroundBlur: 0 });
      assert.equal(media.cameraStream.value, raw);
      await media.setCameraQuality('auto');
      await media.releaseCamera();
      assert.equal(raw.getVideoTracks()[0].readyState, 'ended');
      assert.equal(media.cameraStream.value, null);
    } finally {
      if (recording) await recorder.stopSession();
      media?.camera.endRecording();
      await media?.camera.dispose();
      preview.pause(); preview.srcObject = null;
      mounted?.unmount(); element.remove();
      clearInterval(timer); raw.getTracks().forEach(track => track.stop());
      navigator.mediaDevices.getUserMedia = originalAcquire;
      navigator.mediaDevices.enumerateDevices = originalEnumerate;
      delete window.__ce1Raw;
    }
  }

  async run() {
    let inference; let second; let surface; let raw;
    try {
      const { compositor, source, output } = this.pixels();
      if (process.argv.includes('--ce1-pixels-only')) {
        ipcRenderer.send('ce1-result', { ok: true });
        return;
      }
      const resources = process.argv.find(arg => arg.startsWith('--ce1-resources=')).slice('--ce1-resources='.length);
      await this.composition(resources);
      // risk: media-ownership — cap allocations without stopping caller audio/video.
      const generated = this.canvas(1920, 1080);
      generated.getContext('2d').fillRect(0, 0, 1920, 1080);
      raw = generated.captureStream(1);
      surface = new BrowserFrameSurface(document, window);
      const processed = await surface.open(raw);
      assert.equal(surface.canvas.width, 1280);
      assert.equal(surface.canvas.height, 720);
      assert.equal(processed.getAudioTracks().length, 0);
      surface.close();
      assert.equal(raw.getVideoTracks()[0].readyState, 'live', 'Raw track ownership changed');
      const gate = new VisionInitializationGate();
      inference = new OfflinePersonInference(resources, nativeRequire, filename => readFile(filename), gate);
      second = new OfflinePersonInference(resources, nativeRequire, filename => readFile(filename), gate);
      // Real pinned MediaPipe JS + WASM + TFLite model. Synthetic frame, NOT synthetic inference.
      await Promise.all([inference.initialize(), second.initialize()]);
      for (const timestamp of [1, 100]) {
        const mask = await (timestamp === 1 ? inference : second).infer(source, timestamp);
        assert.ok(mask.width > 0 && mask.height > 0);
        assert.equal(mask.categories.length, mask.width * mask.height);
        assert.ok(mask.categories.every(category => category <= 5));
        compositor.draw(source, output, mask, { autoFrame: true, soften: 0.5, backgroundBlur: 0.5 }, timestamp);
        assert.equal(output.getContext('2d').getImageData(128, 80, 1, 1).data[3], 255);
      }
      compositor.close();
      assert.ok(this.surfaces.every(canvas => canvas.width === 0 && canvas.height === 0), 'Compositor surfaces retained on close');
      ipcRenderer.send('ce1-result', { ok: true, evidence: 'pixel coordinates/edges/crop/selective skin; two real offline WASM/model inferences and composites; actual composition default-off, recording locks, encoded camera.webm decoded pixel proof' });
    } catch (error) {
      ipcRenderer.send('ce1-result', { ok: false, error: error.stack || String(error) });
    } finally {
      inference?.close();
      second?.close();
      surface?.close();
      raw?.getTracks().forEach(track => track.stop());
    }
  }
}
new CameraEffectsRendererSmoke().run();
