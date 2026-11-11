// SPDX-License-Identifier: GPL-2.0-or-later
import type { PersonMask } from './PersonInference';

export interface EffectOptions { autoFrame: boolean; soften: number; backgroundBlur: number }
export interface Crop { x: number; y: number; width: number; height: number }

/** Tracks the largest connected silhouette. Touching people are one subject, not instance-separated. */
export class PersonFraming {
  private center = { x: 0.5, y: 0.5 };
  private lastTime?: number;
  private visited = new Uint8Array(0);
  private queue = new Int32Array(0);

  close(): void {
    this.visited = new Uint8Array(0); this.queue = new Int32Array(0);
    this.lastTime = undefined; this.center = { x: 0.5, y: 0.5 };
  }

  crop(mask: PersonMask | undefined, width: number, height: number, timestamp: number, enabled: boolean): Crop {
    let target = { x: 0.5, y: 0.5 };
    let found = false;

    if (enabled && mask) {
      if (this.visited.length !== mask.categories.length) {
        this.visited = new Uint8Array(mask.categories.length);
        this.queue = new Int32Array(mask.categories.length);
      }
      const visited = this.visited; const queue = this.queue;
      visited.fill(0);
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
          for (let direction = 0; direction < 4; direction++) {
            const next = direction === 0 ? (x > 0 ? index - 1 : -1) :
              direction === 1 ? (x + 1 < mask.width ? index + 1 : -1) :
                direction === 2 ? (y > 0 ? index - mask.width : -1) :
                  (y + 1 < mask.height ? index + mask.width : -1);
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
  validate(mask: PersonMask): void {
    if (!Number.isSafeInteger(mask.width) || !Number.isSafeInteger(mask.height) ||
        mask.width <= 0 || mask.height <= 0 || mask.width * mask.height > 1280 * 720 || mask.width * mask.height !== mask.categories.length ||
        mask.categories.some(category => category > 5)) throw new Error('Invalid person mask');
  }
  alpha(mask: PersonMask, faceOnly: boolean, pixels = new Uint8ClampedArray(mask.categories.length * 4)): Uint8ClampedArray {
    this.validate(mask);
    if (pixels.length !== mask.categories.length * 4) throw new Error('Invalid alpha buffer');
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
  private readonly padded: HTMLCanvasElement;
  private readonly small: HTMLCanvasElement;
  private readonly blurred: HTMLCanvasElement;
  private maskPixels?: ImageData;

  constructor(
    private readonly framing: PersonFraming,
    makeCanvas: () => HTMLCanvasElement,
    private readonly rasterizer: PersonMaskRasterizer = new PersonMaskRasterizer(),
  ) {
    this.scene = makeCanvas(); this.layer = makeCanvas(); this.maskCanvas = makeCanvas(); this.padded = makeCanvas();
    this.small = makeCanvas(); this.blurred = makeCanvas();
  }

  close(): void {
    for (const canvas of [this.scene, this.layer, this.maskCanvas, this.padded, this.small, this.blurred]) { canvas.width = 0; canvas.height = 0; }
    this.maskPixels = undefined;
    this.framing.close();
  }

  draw(video: HTMLVideoElement, output: HTMLCanvasElement, mask: PersonMask | undefined, options: EffectOptions, timestamp: number): void {
    if (mask) this.rasterizer.validate(mask);
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
        // Blur at quarter resolution: a heavy blur hides the lost detail and costs ~16x fewer pixels.
        this.blurBackground(video, width, height, Math.min(12, options.backgroundBlur * 12));
        scene.drawImage(this.blurred, 0, 0, width, height);
        scene.drawImage(this.layer, 0, 0);
      }
      if (options.soften > 0) {
        this.paintMask(mask, true);
        const layer = this.context(this.layer);
        layer.clearRect(0, 0, width, height);
        // Softening = a half-resolution copy scaled back up (bilinear), no per-frame CSS blur filter.
        this.shrink(this.small, video, width, height, 0.5);
        layer.imageSmoothingEnabled = true;
        layer.drawImage(this.small, 0, 0, width, height);
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

  private shrink(target: HTMLCanvasElement, source: CanvasImageSource, width: number, height: number, scale: number): void {
    const w = Math.max(1, Math.ceil(width * scale)); const h = Math.max(1, Math.ceil(height * scale));
    if (target.width !== w) target.width = w;
    if (target.height !== h) target.height = h;
    this.context(target).drawImage(source, 0, 0, w, h);
  }

  private blurBackground(video: HTMLVideoElement, width: number, height: number, radius: number): void {
    const scale = 0.25;
    this.shrink(this.small, video, width, height, scale);
    const w = this.small.width; const h = this.small.height; const pad = 12;
    // Extend boundary pixels so the blur does not darken the frame edges.
    if (this.padded.width !== w + pad * 2) this.padded.width = w + pad * 2;
    if (this.padded.height !== h + pad * 2) this.padded.height = h + pad * 2;
    const padded = this.context(this.padded);
    padded.clearRect(0, 0, this.padded.width, this.padded.height);
    const xs = [[0, 1, 0, pad], [0, w, pad, w], [w - 1, 1, pad + w, pad]];
    const ys = [[0, 1, 0, pad], [0, h, pad, h], [h - 1, 1, pad + h, pad]];
    for (const [sx, sw, dx, dw] of xs) {
      for (const [sy, sh, dy, dh] of ys) padded.drawImage(this.small, sx, sy, sw, sh, dx, dy, dw, dh);
    }
    if (this.blurred.width !== w) this.blurred.width = w;
    if (this.blurred.height !== h) this.blurred.height = h;
    const out = this.context(this.blurred);
    out.clearRect(0, 0, w, h);
    out.filter = `blur(${ radius * scale }px)`;
    out.drawImage(this.padded, -pad, -pad);
    out.filter = 'none';
  }

  private paintMask(mask: PersonMask, faceOnly: boolean): void {
    if (this.maskCanvas.width !== mask.width) this.maskCanvas.width = mask.width;
    if (this.maskCanvas.height !== mask.height) this.maskCanvas.height = mask.height;
    const context = this.context(this.maskCanvas);
    if (!this.maskPixels || this.maskPixels.width !== mask.width || this.maskPixels.height !== mask.height) {
      this.maskPixels = context.createImageData(mask.width, mask.height);
    }
    const pixels = this.maskPixels;
    this.rasterizer.alpha(mask, faceOnly, pixels.data);
    context.putImageData(pixels, 0, 0);
  }
}
