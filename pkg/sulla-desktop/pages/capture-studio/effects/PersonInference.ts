// SPDX-License-Identifier: GPL-2.0-or-later
import path from 'path';
import { pathToFileURL } from 'url';

export interface PersonMask {
  width: number;
  height: number;
  /** Category IDs: background=0, hair=1, body skin=2, face skin=3, clothes=4, other=5. */
  categories: Uint8Array;
}
export interface PersonInference {
  initialize(): Promise<void>;
  infer(frame: HTMLVideoElement | HTMLCanvasElement, timestamp: number): Promise<PersonMask>;
  close(): void;
}
interface VisionMask {
  width: number;
  height: number;
  getAsUint8Array(): Uint8Array;
}
interface VisionResult { categoryMask?: VisionMask; close(): void }
interface Segmenter {
  segmentForVideo(frame: HTMLVideoElement | HTMLCanvasElement, timestamp: number): VisionResult;
  close(): void;
}
export interface VisionRuntime {
  FilesetResolver: { forVisionTasks(root: string): Promise<unknown> };
  ImageSegmenter: { createFromOptions(files: unknown, options: unknown): Promise<Segmenter> };
}

/**
 * One injected gate per renderer composition root, shared by every inference factory.
 * MediaPipe script initialization may use global ModuleFactory; serialize that phase.
 */
export class VisionInitializationGate {
  private pending: Promise<unknown> = Promise.resolve();

  run<T>(initialize: () => Promise<T>): Promise<T> {
    const result = this.pending.then(initialize);
    this.pending = result.catch(() => undefined);
    return result;
  }
}

/** Uses only versioned extraResources; never resolves a CDN or downloads on first use. */
export class OfflinePersonInference implements PersonInference {
  private segmenter?: Segmenter;

  constructor(
    private readonly resourceDirectory: string,
    // Inject Electron's native require at composition, never webpack's dynamic require.
    private readonly loadRuntime: (filename: string) => VisionRuntime,
    private readonly readModel: (filename: string) => Promise<Uint8Array>,
    private readonly initializationGate: VisionInitializationGate,
  ) {}

  async initialize(): Promise<void> {
    await this.initializationGate.run(async() => {
      const runtime = this.loadRuntime(path.join(this.resourceDirectory, 'vendor', 'vision_bundle.cjs'));
      const files = await runtime.FilesetResolver.forVisionTasks(
        pathToFileURL(path.join(this.resourceDirectory, 'vendor', 'wasm')).href,
      );
      this.segmenter = await runtime.ImageSegmenter.createFromOptions(files, {
        baseOptions: {
          // Chromium fetch(file://) is not a portable model loader. Use injected native bytes.
          modelAssetBuffer: await this.readModel(path.join(this.resourceDirectory, 'selfie_multiclass_256x256.tflite')),
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    });
  }

  async infer(frame: HTMLVideoElement | HTMLCanvasElement, timestamp: number): Promise<PersonMask> {
    if (!this.segmenter) throw new Error('Person inference is not initialized');
    const result = this.segmenter.segmentForVideo(frame, timestamp);

    try {
      if (!result.categoryMask) throw new Error('Person segmentation returned no mask');
      const mask = result.categoryMask;

      return { width: mask.width, height: mask.height, categories: mask.getAsUint8Array().slice() };
    } finally {
      result.close();
    }
  }

  close(): void {
    const segmenter = this.segmenter;
    this.segmenter = undefined;
    segmenter?.close();
  }
}

/** Bound model upload/preprocessing input independently of the 720p compositor cap. */
export class BoundedPersonInference implements PersonInference {
  constructor(private readonly inner: PersonInference, private readonly canvas: HTMLCanvasElement) {}
  initialize(): Promise<void> { return this.inner.initialize(); }
  infer(frame: HTMLVideoElement | HTMLCanvasElement, timestamp: number): Promise<PersonMask> {
    const width = 'videoWidth' in frame ? frame.videoWidth : frame.width;
    const height = 'videoHeight' in frame ? frame.videoHeight : frame.height;
    if (!width || !height) throw new Error('Inference input is empty');
    const scale = Math.min(1, 512 / width, 512 / height);
    const targetWidth = Math.max(1, Math.floor(width * scale));
    const targetHeight = Math.max(1, Math.floor(height * scale));
    if (this.canvas.width !== targetWidth) this.canvas.width = targetWidth;
    if (this.canvas.height !== targetHeight) this.canvas.height = targetHeight;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Inference preprocessing canvas unavailable');
    context.drawImage(frame, 0, 0, targetWidth, targetHeight);
    return this.inner.infer(this.canvas, timestamp);
  }
  close(): void {
    try { this.inner.close(); }
    finally { this.canvas.width = 0; this.canvas.height = 0; }
  }
}
