// SPDX-License-Identifier: GPL-2.0-or-later
import { createRequire } from 'module';
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
interface VisionRuntime {
  FilesetResolver: { forVisionTasks(root: string): Promise<unknown> };
  ImageSegmenter: { createFromOptions(files: unknown, options: unknown): Promise<Segmenter> };
}

/** Uses only versioned extraResources; never resolves a CDN or downloads on first use. */
export class OfflinePersonInference implements PersonInference {
  private segmenter?: Segmenter;

  constructor(
    private readonly resourceDirectory: string,
    private readonly loadRuntime: (filename: string) => VisionRuntime =
      filename => createRequire(filename)(filename) as VisionRuntime,
  ) {}

  async initialize(): Promise<void> {
    const runtime = this.loadRuntime(path.join(this.resourceDirectory, 'vendor', 'vision_bundle.cjs'));
    const files = await runtime.FilesetResolver.forVisionTasks(
      pathToFileURL(path.join(this.resourceDirectory, 'vendor', 'wasm')).href,
    );
    this.segmenter = await runtime.ImageSegmenter.createFromOptions(files, {
      baseOptions: {
        modelAssetPath: pathToFileURL(path.join(this.resourceDirectory, 'selfie_multiclass_256x256.tflite')).href,
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
