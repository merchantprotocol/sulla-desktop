// SPDX-License-Identifier: GPL-2.0-or-later
import type { PersonMask } from './PersonInference';

export interface EffectOptions { autoFrame: boolean; soften: number; backgroundBlur: number }
export interface Crop { x: number; y: number; width: number; height: number }

/** Tracks the largest connected person silhouette, not a hard-coded center mask. */
export class PersonFraming {
  private center = { x: 0.5, y: 0.5 };
  private lastTime?: number;

  crop(mask: PersonMask | undefined, width: number, height: number, timestamp: number, enabled: boolean): Crop {
    let target = { x: 0.5, y: 0.5 };
    let found = false;

    if (enabled && mask) {
      const visited = new Uint8Array(mask.categories.length);
      const queue = new Int32Array(mask.categories.length);
      let largest = 0;

      for (let i = 0; i < visited.length; i++) {
        if (visited[i] || !mask.categories[i]) continue;
        let head = 0; let tail = 1; let sumX = 0; let sumY = 0;
        queue[0] = i;
        visited[i] = 1;
        while (head < tail) {
          const index = queue[head++];
          const x = index % mask.width; const y = Math.floor(index / mask.width);
          sumX += x + 0.5; sumY += y + 0.5;
          const neighbors = [
            x > 0 ? index - 1 : -1, x + 1 < mask.width ? index + 1 : -1,
            y > 0 ? index - mask.width : -1, y + 1 < mask.height ? index + mask.width : -1,
          ];
          for (const next of neighbors) {
            if (next >= 0 && !visited[next] && mask.categories[next]) {
              visited[next] = 1; queue[tail++] = next;
            }
          }
        }
        if (tail > largest && tail / visited.length >= 0.02) {
          largest = tail;
          target = { x: sumX / tail / mask.width, y: sumY / tail / mask.height };
          found = true;
        }
      }
    }
    const elapsed = Math.max(0, Math.min(250, timestamp - (this.lastTime ?? timestamp)));
    const alpha = this.lastTime === undefined ? 1 : 1 - Math.exp(-elapsed / (found ? 450 : 1200));
    this.lastTime = timestamp;
    this.center.x += (target.x - this.center.x) * alpha;
    this.center.y += (target.y - this.center.y) * alpha;
    const scale = enabled ? 0.8 : 1;
    const cropWidth = width * scale; const cropHeight = height * scale;

    return {
      x: Math.max(0, Math.min(width - cropWidth, this.center.x * width - cropWidth / 2)),
      y: Math.max(0, Math.min(height - cropHeight, this.center.y * height - cropHeight / 2)),
      width: cropWidth,
      height: cropHeight,
    };
  }
}


/** Converts real multiclass labels to alpha without ever softening hair, clothing or background. */
export class PersonMaskRasterizer {
  alpha(mask: PersonMask, faceOnly: boolean): Uint8ClampedArray {
    if (mask.width * mask.height !== mask.categories.length) throw new Error('Invalid person mask');
    const pixels = new Uint8ClampedArray(mask.categories.length * 4);
    for (let i = 0; i < mask.categories.length; i++) {
      pixels[i * 4 + 3] = (faceOnly ? mask.categories[i] === 3 : mask.categories[i] !== 0) ? 255 : 0;
    }
    return pixels;
  }
}

/** Reusable canvas layers: raw -> person-over-blurred-background -> face-skin-only softening -> crop. */
export class FrameCompositor {
  private readonly scene: HTMLCanvasElement;
  private readonly layer: HTMLCanvasElement;
  private readonly maskCanvas: HTMLCanvasElement;

  constructor(
    private readonly framing: PersonFraming,
    makeCanvas: () => HTMLCanvasElement,
    private readonly rasterizer: PersonMaskRasterizer = new PersonMaskRasterizer(),
  ) {
    this.scene = makeCanvas(); this.layer = makeCanvas(); this.maskCanvas = makeCanvas();
  }

  draw(video: HTMLVideoElement, output: HTMLCanvasElement, mask: PersonMask | undefined, options: EffectOptions, timestamp: number): void {
    const width = output.width; const height = output.height;
    for (const canvas of [this.scene, this.layer]) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }
    const scene = this.context(this.scene);
    scene.clearRect(0, 0, width, height);
    scene.drawImage(video, 0, 0, width, height);
    if (mask) {
      if (options.backgroundBlur > 0) {
        this.paintMask(mask, false);
        const layer = this.context(this.layer);
        layer.clearRect(0, 0, width, height);
        layer.drawImage(video, 0, 0, width, height);
        layer.globalCompositeOperation = 'destination-in';
        layer.drawImage(this.maskCanvas, 0, 0, width, height);
        layer.globalCompositeOperation = 'source-over';
        scene.filter = `blur(${ Math.min(12, options.backgroundBlur * 12) }px)`;
        // Overscan prevents transparent blur edges.
        scene.drawImage(video, -24, -24, width + 48, height + 48);
        scene.filter = 'none';
        scene.drawImage(this.layer, 0, 0);
      }
      if (options.soften > 0) {
        this.paintMask(mask, true);
        const layer = this.context(this.layer);
        layer.clearRect(0, 0, width, height);
        layer.filter = 'blur(1.5px)';
        layer.drawImage(video, 0, 0, width, height);
        layer.filter = 'none';
        layer.globalCompositeOperation = 'destination-in';
        layer.drawImage(this.maskCanvas, 0, 0, width, height);
        layer.globalCompositeOperation = 'source-over';
        scene.globalAlpha = Math.min(0.35, options.soften * 0.35);
        scene.drawImage(this.layer, 0, 0);
        scene.globalAlpha = 1;
      }
    }
    const crop = this.framing.crop(mask, width, height, timestamp, options.autoFrame);
    const context = this.context(output);
    context.clearRect(0, 0, width, height);
    context.drawImage(this.scene, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  }

  private context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Camera effects need a 2D canvas');
    return context;
  }

  private paintMask(mask: PersonMask, faceOnly: boolean): void {
    this.maskCanvas.width = mask.width; this.maskCanvas.height = mask.height;
    const context = this.context(this.maskCanvas);
    const pixels = context.createImageData(mask.width, mask.height);
    pixels.data.set(this.rasterizer.alpha(mask, faceOnly));
    context.putImageData(pixels, 0, 0);
  }
}
