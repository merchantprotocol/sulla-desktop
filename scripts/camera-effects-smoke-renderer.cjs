// SPDX-License-Identifier: GPL-2.0-or-later
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { ipcRenderer } = require('electron');
const { FrameCompositor, PersonFraming } = require('./FrameCompositor');
const { OfflinePersonInference, VisionInitializationGate } = require('./PersonInference');
const { createApp, h } = require('vue');
const { ContextMenuSmoke } = require('./menu-smoke');
const { PreviewBindingsSmoke } = require('./preview-smoke');
const { CameraEffectsComposition, cameraEffectsKey } = require('./CameraEffectsComposition');
const { useMediaSources } = require('./useMediaSources');
const { useRecorder } = require('./useRecorder');
const { useAgentBridge } = require('./useAgentBridge');
const { sourceEnable } = require('./source-enable');
const { useAudioDriver } = require('./useAudioDriver');
const { useSpeakerCapture } = require('./useSpeakerCapture');
const { cameraBridge } = require('./camera-bridge');
const { CaptureSessionLifecycle } = require('./CaptureSessionLifecycle');
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

  async bridgeRelease() {
    const send = ipcRenderer.send;
    try {
      return await new Promise(resolve => {
        ipcRenderer.send = (channel, ...args) => {
          if (channel === 'capture-studio:rpc-reply') resolve(args[0]);
          else send.call(ipcRenderer, channel, ...args);
        };
        ipcRenderer.emit('capture-studio:rpc', {}, { rpcId: 'ce1-release', command: 'camera.release', params: {} });
      });
    } finally { ipcRenderer.send = send; }
  }

  async sourceStartup() {
    // risk: media-privacy — execute production SFC toggles and real composables after teardown begins.
    const originalInvoke = ipcRenderer.invoke;
    const originalDisplay = navigator.mediaDevices.getDisplayMedia;
    const audio = new AudioContext();
    const destination = audio.createMediaStreamDestination();
    const oscillator = audio.createOscillator(); oscillator.connect(destination); oscillator.start();
    try {
      for (const scenario of ['native-success', 'native-rejection', 'mic']) {
        const lifecycle = new CaptureSessionLifecycle();
        let settle; let entered;
        const started = new Promise(resolve => { entered = resolve; });
        const deferred = new Promise((resolve, reject) => { settle = scenario === 'native-rejection' ? () => reject(new Error('synthetic native rejection')) : resolve; });
        let fallback = 0; let micStops = 0; let driver; let speaker; let publications = 0;
        ipcRenderer.invoke = async(channel) => {
          if (channel === 'audio-driver:start-mic') { entered(); return deferred; }
          if (channel === 'audio-driver:stop-mic') { micStops++; return { micRunning: false }; }
          if (channel === 'audio-driver:start-speaker') { fallback++; return { speakerRunning: true }; }
          if (channel === 'audio-driver:stop-speaker') return { speakerRunning: false };
          throw new Error('Unexpected synthetic IPC: ' + channel);
        };
        navigator.mediaDevices.getDisplayMedia = async() => { entered(); return deferred; };
        const element = document.createElement('div'); document.body.appendChild(element);
        const mounted = createApp({ setup() { driver = useAudioDriver(); speaker = useSpeakerCapture({ manageUnmount: false }); return () => h('div'); } });
        mounted.mount(element);
        try {
          const toggle = sourceEnable(lifecycle, {}, driver, speaker, { value: '' }, () => { publications++; }, () => { publications++; }, { value: 'audioonly' }, {}, { value: [] }, { value: null });
          const source = { id: scenario, type: scenario === 'mic' ? 'mic' : 'system', on: false };
          const startup = toggle(source);
          await started;
          let released = false;
          const shutdown = lifecycle.close(async() => {
            speaker.releaseNative(); await driver.stopMic(); await driver.stopSpeaker(); released = true;
          });
          mounted.unmount();
          await new Promise(resolve => setTimeout(resolve, 0));
          assert.equal(released, false, 'Shutdown skipped pending actual source startup');
          const track = destination.stream.getAudioTracks()[0].clone();
          settle(scenario === 'mic' ? { micRunning: true } : new MediaStream([track]));
          await startup; await shutdown;
          assert.equal(released, true);
          assert.equal(speaker.nativeStream.value, null, 'Late native stream resurrected');
          assert.equal(speaker.active.value, false);
          assert.equal(speaker.level.value, 0, 'Late native meter resurrected');
          assert.equal(driver.micRunning.value, false, 'Late mic start resurrected');
          assert.ok(micStops >= 1);
          assert.equal(fallback, 0, 'Native failure resumed BlackHole after shutdown');
          assert.equal(publications, 0, 'Closing source startup published assignments');
          assert.equal(source.on, false);
          if (scenario === 'native-success') assert.equal(track.readyState, 'ended', 'Cancelled native track leaked');
          track.stop();
        } finally { mounted.unmount(); element.remove(); }
      }
      console.log('CE1 production source-enable late native/mic/fallback regressions passed');
    } finally {
      oscillator.stop(); destination.stream.getTracks().forEach(track => track.stop()); await audio.close();
      ipcRenderer.invoke = originalInvoke; navigator.mediaDevices.getDisplayMedia = originalDisplay;
    }
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
    const menu = new ContextMenuSmoke();
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
      mounted = createApp({ setup() { media = useMediaSources(); recorder = useRecorder({ manageUnmount: false }); useAgentBridge(cameraBridge(media)); return () => h('div'); } });
      mounted.provide(cameraEffectsKey, composition.effects);
      mounted.mount(element);
      await media.acquireCamera();
      assert.equal(loads, 0, 'Default-off loaded a model');
      assert.equal(media.cameraStream.value, raw, 'Off must preserve raw');
      await menu.mount(media);
      await menu.framing();
      assert.equal(loads, 1, 'Actual composition did not initialize model');
      const shared = media.cameraStream.value;
      assert.notEqual(shared, raw);
      assert.equal(await media.camera.beginRecording(), shared);
      await menu.lock();
      preview.srcObject = shared; await preview.play();
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.throws(() => media.camera.setOptions({ autoFrame: false, soften: 0, backgroundBlur: 0 }), /Stop recording/);
      await assert.rejects(media.switchCamera('synthetic-other-device'), /Stop recording/);
      await assert.rejects(media.setCameraQuality('480p'), /Stop recording/);
      await assert.rejects(media.releaseCamera(), /Stop recording/);
      const blockedBridge = await this.bridgeRelease();
      assert.equal(blockedBridge.ok, false);
      assert.match(blockedBridge.error, /Stop recording/);
      const session = recorder.startSession([{ id: 'cam', type: 'camera', stream: shared, quality: '720p' }]);
      assert.ok(session, recorder.error.value);
      recording = true;
      const filename = require('path').join(recorder.getSessionDir(), 'camera.webm');
      await new Promise(resolve => setTimeout(resolve, 650));
      assert.equal(media.cameraStream.value, shared, 'Recording output replaced');
      const firstStop = recorder.stopSession();
      assert.equal(recorder.stopSession(), firstStop, 'Concurrent stop did not join final flush');
      await firstStop; recording = false;
      media.camera.endRecording();
      const saved = await readFile(filename);
      assert.ok(saved.length > 100, 'No encoded file saved');
      const playback = document.createElement('video');
      playback.muted = true; playback.playsInline = true;
      const url = URL.createObjectURL(new Blob([saved], { type: 'video/webm' }));
      try {
        await new Promise((resolve, reject) => { playback.onloadeddata = resolve; playback.onerror = () => reject(new Error('Saved WebM did not decode')); playback.src = url; playback.load(); });
        assert.ok(Number.isFinite(playback.videoWidth) && playback.videoWidth > 0 && Number.isFinite(playback.videoHeight) && playback.videoHeight > 0, 'Decoded dimensions unavailable');
        const decoded = this.canvas(1280, 720);
        // Rasterize while the decoded frame is presented, before pause can release its texture.
        const presented = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Decoded frame presentation timed out')), 10000);
          playback.requestVideoFrameCallback((_now, metadata) => {
            try {
              assert.ok(playback.readyState >= 2 && metadata.presentedFrames > 0, 'Decoded frame not ready: ' + JSON.stringify({ readyState: playback.readyState, metadata }));
              assert.ok(Number.isFinite(metadata.width) && metadata.width > 0 && Number.isFinite(metadata.height) && metadata.height > 0, 'Presented dimensions unavailable');
              decoded.getContext('2d').drawImage(playback, 0, 0, 1280, 720);
              resolve();
            } catch (error) { reject(error); } finally { clearTimeout(timeout); }
          });
        });
        document.body.appendChild(playback);
        await playback.play(); await presented;
        const edge = decoded.getContext('2d').getImageData(4, 360, 1, 1).data;
        const center = decoded.getContext('2d').getImageData(640, 360, 1, 1).data;
        console.log('CE1 decoded frame ' + JSON.stringify({ width: playback.videoWidth, height: playback.videoHeight, readyState: playback.readyState, edge: [...edge], center: [...center] }));
        assert.equal(edge[3], 255, 'DECODE_NOT_OPAQUE: saved edge');
        assert.equal(center[3], 255, 'DECODE_NOT_OPAQUE: saved center');
        assert.ok(center[1] > 180 && center[0] < 70, 'DECODE_SIGNAL_MISSING: saved center');
        assert.ok(edge[1] > 180 && edge[0] < 70, 'RAW_LEAK_SENTINEL: saved video contains raw red edge: ' + [...edge]);
        playback.pause();
        assert.equal(playback.videoWidth, 1280);
        assert.equal(playback.videoHeight, 720);
        decoded.getContext('2d').drawImage(preview, 0, 0, 1280, 720);
        const live = decoded.getContext('2d').getImageData(4, 360, 1, 1).data;
        assert.ok(live[1] > 180 && live[0] < 70, 'Preview and saved video differ');
      } finally { playback.pause(); playback.src = ''; playback.remove(); URL.revokeObjectURL(url); }
      // Keep assignment churn isolated from the existing encoded-frame timing oracle.
      await new PreviewBindingsSmoke((width, height) => this.canvas(width, height)).run(shared);
      await menu.strengths();
      await media.camera.setOptions({ autoFrame: false, soften: 0, backgroundBlur: 0 });
      assert.equal(media.cameraStream.value, raw);
      await media.setCameraQuality('auto');
      assert.equal((await this.bridgeRelease()).ok, true);
      assert.equal(raw.getVideoTracks()[0].readyState, 'ended');
      assert.equal(media.cameraStream.value, null);
      // Actual SFC callback must release, not permanently dispose; reacquisition remains usable.
      navigator.mediaDevices.getUserMedia = async() => source.captureStream(30);
      await media.acquireCamera();
      const screenCanvas = this.canvas(64, 64);
      screenCanvas.getContext('2d').fillRect(0, 0, 64, 64);
      const screen = screenCanvas.captureStream(5);
      media.screenStream.value = screen;
      const lifecycle = new CaptureSessionLifecycle();
      let resolveAudio; let audioSettled = false; let released = false;
      const deferredAudio = new Promise(resolve => { resolveAudio = resolve; });
      const transition = lifecycle.run(async() => {
        await media.camera.beginRecording();
        assert.ok(recorder.startSession([{ id: 'cam', type: 'camera', stream: media.cameraStream.value }, { id: 'screen', type: 'screen', stream: screen }]));
        await deferredAudio; audioSettled = true;
        assert.equal(lifecycle.isClosing, true, 'Shutdown did not invalidate startup');
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      const rawDuringStart = media.camera.rawStream;
      mounted.unmount(); mounted = undefined;
      assert.equal(screen.getVideoTracks()[0].readyState, 'live', 'Composable unmount released screen before final flush');
      assert.equal(rawDuringStart.getVideoTracks()[0].readyState, 'live');
      const shutdown = lifecycle.close(async() => {
        assert.equal(audioSettled, true, 'Released before deferred audio settled');
        const flush = recorder.stopSession();
        assert.equal(recorder.stopSession(), flush);
        assert.equal(rawDuringStart.getVideoTracks()[0].readyState, 'live');
        await flush;
        media.camera.endRecording();
        media.releaseScreen();
        await media.camera.dispose(); released = true;
      });
      assert.equal(lifecycle.close(async() => { throw new Error('Duplicate cleanup'); }), shutdown);
      assert.equal(released, false);
      resolveAudio(); await transition; await shutdown;
      assert.equal(released, true);
      assert.equal(rawDuringStart.getVideoTracks()[0].readyState, 'ended');
    } finally {
      if (recording) await recorder.stopSession();
      media?.camera.endRecording();
      await media?.camera.dispose();
      preview.pause(); preview.srcObject = null;
      menu.close();
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
      await this.sourceStartup();
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
