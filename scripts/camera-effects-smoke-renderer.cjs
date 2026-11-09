// SPDX-License-Identifier: GPL-2.0-or-later
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { ipcRenderer } = require('electron');
const { FrameCompositor, PersonFraming } = require('./FrameCompositor');
const { OfflinePersonInference, VisionInitializationGate } = require('./PersonInference');
const nativeRequire = require('node:module').createRequire(process.resourcesPath + '/ce1-native.cjs');

class CameraEffectsRendererSmoke {
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
    const compositor = new FrameCompositor(new PersonFraming(), () => this.canvas(1, 1));
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
    compositor.draw(source, output, mask, { autoFrame: true, soften: 0, backgroundBlur: 1 }, 0);
    // Off-center mask centers at x=72; crop clamps at x=0. Same 0.8 crop in both axes.
    for (const x of [60, 90, 150, 200]) {
      const expectedX = Math.floor((x + 0.5) * 0.8);
      const actual = output.getContext('2d').getImageData(x, 80, 1, 1).data;
      const expected = reference.data[(80 * 256 + expectedX) * 4];
      assert.ok(Math.abs(actual[0] - expected) <= 3, 'Framed foreground/background coordinates changed');
    }
    // Use a fresh tracker to test centered no-subject crop without prior tracking state.
    const centered = new FrameCompositor(new PersonFraming(), () => this.canvas(1, 1));
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
    centered.close();
    return { compositor, source, output };
  }

  async run() {
    let inference; let second;
    try {
      const { compositor, source, output } = this.pixels();
      if (process.argv.includes('--ce1-pixels-only')) {
        ipcRenderer.send('ce1-result', { ok: true });
        return;
      }
      const resources = process.argv.find(arg => arg.startsWith('--ce1-resources=')).slice('--ce1-resources='.length);
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
      ipcRenderer.send('ce1-result', { ok: true, evidence: 'pixel coordinates/edges/crop/selective skin; two real offline WASM/model inferences and composites' });
    } catch (error) {
      ipcRenderer.send('ce1-result', { ok: false, error: error.stack || String(error) });
    } finally {
      inference?.close();
      second?.close();
    }
  }
}
new CameraEffectsRendererSmoke().run();
