// SPDX-License-Identifier: GPL-2.0-or-later
const assert = require('node:assert/strict');
const { FrameCompositor, PersonFraming } = require('./FrameCompositor');

/** risk: recorded-image-integrity — compositor pixels on a synthetic gradient, no devices or model. */
class CameraEffectsPixelSmoke {
  surfaces = [];

  constructor(createCanvas) { this.canvas = createCanvas; }

  layer() {
    const canvas = this.canvas(1, 1);
    this.surfaces.push(canvas);
    return canvas;
  }

  compositor() { return new FrameCompositor(new PersonFraming(), () => this.layer()); }

  /**
   * First x inside the black block [210, 256) that the block's left edge cannot reach under
   * blur. FrameCompositor uses CSS blur(12 * strength px), a Gaussian with that standard
   * deviation; beyond 3 sigma its one-sided weight is under 0.14%, and Skia's three-pass box
   * approximation has about the same support. So 3 sigma plus a 4px rounding margin:
   * x=223 at strength 0.25 and x=250 at strength 1 (40px in; the right side is edge-extended
   * black, so x=250 is not near a real edge either). x=230 at full blur was only 20px
   * (1.7 sigma) in, where the gradient legitimately bleeds about 10 levels into the block.
   */
  blackInterior(strength) { return 210 + Math.ceil(3 * 12 * strength) + 4; }

  run() {
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
    const compositor = this.compositor();
    const categories = new Uint8Array(256 * 160);
    for (let y = 0; y < 160; y++) categories.fill(4, y * 256 + 60, y * 256 + 84);
    const mask = { width: 256, height: 160, categories };
    for (const strength of [0.25, 1]) {
      compositor.draw(source, output, mask, { autoFrame: false, soften: 0, backgroundBlur: strength }, 0);
      const pixels = output.getContext('2d').getImageData(0, 0, 256, 160).data;
      for (const offset of [0, 255, 159 * 256, 160 * 256 - 1]) assert.equal(pixels[offset * 4 + 3], 255, 'Transparent blur edge');
      // A scaled/offset background (the overscan regression) drags the bright gradient into this point.
      const x = this.blackInterior(strength);
      assert.ok(pixels[(80 * 256 + x) * 4] < 12, 'High contrast background moved at ' + x + ' (blur ' + strength + '): ' + pixels[(80 * 256 + x) * 4]);
    }
    // Coordinate identity is a sharp-image oracle. Blur intentionally changes
    // background pixels, so do not compare them with the unfiltered x-gradient.
    compositor.draw(source, output, mask, { autoFrame: false, soften: 0, backgroundBlur: 0 }, 10);
    const sharpPixels = output.getContext('2d').getImageData(0, 0, 256, 160).data;
    for (const x of [64, 80, 128, 160, 176]) {
      assert.ok(Math.abs(sharpPixels[(80 * 256 + x) * 4] - x) <= 3, 'Scene coordinates changed at ' + x);
    }
    const reference = output.getContext('2d').getImageData(0, 0, 256, 160);
    const framed = this.compositor();
    // Isolate crop coordinates from blur blending around the mask boundary.
    framed.draw(source, output, mask, { autoFrame: true, soften: 0, backgroundBlur: 0 }, 0);
    // Off-center mask centers at x=72; crop clamps at x=0. Same 0.8 crop in both axes.
    for (const x of [60, 90, 150, 200]) {
      const expectedX = Math.floor((x + 0.5) * 0.8);
      const actual = output.getContext('2d').getImageData(x, 80, 1, 1).data;
      const expected = reference.data[(80 * 256 + expectedX) * 4];
      assert.ok(Math.abs(actual[0] - expected) <= 3, 'Framed foreground/background coordinates changed at ' + x + ': ' + actual[0] + ' vs ' + expected);
    }
    const sharpFramed = output.getContext('2d').getImageData(0, 0, 256, 160);
    // Auto-framing + full blur together: the person stays sharp and framed exactly as without blur.
    // Output x=90 is source x=72, 12px inside the mask [60, 84), far beyond bilinear crop sampling.
    const framedBlur = this.compositor();
    framedBlur.draw(source, output, mask, { autoFrame: true, soften: 0, backgroundBlur: 1 }, 0);
    for (const y of [40, 80, 120]) {
      const actual = output.getContext('2d').getImageData(90, y, 1, 1).data;
      const expected = sharpFramed.data.slice((y * 256 + 90) * 4, (y * 256 + 90) * 4 + 3);
      assert.ok([0, 1, 2].every(channel => Math.abs(actual[channel] - expected[channel]) <= 3), 'Framed person blurred or moved at 90,' + y + ': ' + [...actual] + ' vs ' + [...expected]);
    }
    // Use a fresh tracker to test centered no-subject crop without prior tracking state.
    const centered = this.compositor();
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
    framedBlur.close();
    centered.close();
    return { compositor, source, output };
  }
}
module.exports = { CameraEffectsPixelSmoke };
