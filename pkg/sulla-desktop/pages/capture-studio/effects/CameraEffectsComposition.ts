// SPDX-License-Identifier: GPL-2.0-or-later
import path from 'path';
import type { InjectionKey } from 'vue';

import { BoundedPersonInference, OfflinePersonInference, VisionInitializationGate, type VisionRuntime } from './PersonInference';
import { BrowserFrameSurface, VideoEffectService } from './VideoEffectService';

export const cameraEffectsKey: InjectionKey<VideoEffectService> = Symbol('capture-camera-effects');

/** Instantiate once in the renderer entry; all sessions share its initialization gate. */
export class CameraEffectsComposition {
  private readonly gate = new VisionInitializationGate();
  readonly effects: VideoEffectService;

  constructor(
    resources: string,
    loadRuntime: (filename: string) => VisionRuntime,
    readModel: (filename: string) => Promise<Uint8Array>,
    document: Document,
    window: Window,
    report: (error: unknown) => void,
  ) {
    const canvas = () => document.createElement('canvas');
    this.effects = new VideoEffectService(
      () => new BoundedPersonInference(new OfflinePersonInference(path.join(resources, 'camera-effects'), loadRuntime, readModel, this.gate), canvas()),
      () => new BrowserFrameSurface(document, window), canvas, report,
    );
  }
}
