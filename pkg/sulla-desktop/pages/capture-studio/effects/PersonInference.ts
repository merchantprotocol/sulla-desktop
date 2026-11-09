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
  infer(frame: HTMLVideoElement, timestamp: number): Promise<PersonMask>;
  close(): void;
}
interface VisionMask {
  width: number;
  height: number;
  getAsUint8Array(): Uint8Array;
}
interface VisionResult { categoryMask?: VisionMask; close(): void }
interface Segmenter {
  segmentForVideo(frame: HTMLVideoElement, timestamp: number): VisionResult;
  close(): void;
}
export interface VisionRuntime {
  FilesetResolver: { forVisionTasks(root: string): Promise<unknown> };
  ImageSegmenter: { createFromOptions(files: unknown, options: unknown): Promise<Segmenter> };
}

/** Uses only versioned extraResources; never resolves a CDN or downloads on first use. */
export class OfflinePersonInference implements PersonInference {
  private segmenter?: Segmenter;

  constructor(
    private readonly resourceDirectory: string,
    // Inject Electron's native require at composition, never webpack's dynamic require.
    private readonly loadRuntime: (filename: string) => VisionRuntime,
    private readonly readModel: (filename: string) => Promise<Uint8Array>,
  ) {}

  async initialize(): Promise<void> {
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
  }

  async infer(frame: HTMLVideoElement, timestamp: number): Promise<PersonMask> {
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
