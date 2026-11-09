// SPDX-License-Identifier: GPL-2.0-or-later
import { createApp, type App } from 'vue';

import CaptureStudio from '../../pages/CaptureStudio.vue';
import { CameraEffectsComposition, cameraEffectsKey } from '../../pages/capture-studio/effects/CameraEffectsComposition';
import type { VisionRuntime } from '../../pages/capture-studio/effects/PersonInference';

export interface CaptureWindowContext {
  initialize(): Promise<void>;
}

export interface CaptureWindowHost {
  install(app: App): Promise<void>;
}

export interface CaptureWindowResources {
  readonly directory: string;
  loadRuntime(filename: string): VisionRuntime;
  readModel(filename: string): Promise<Uint8Array>;
}

/** Startup policy is injected at composition time, never selected by shipping flags. */
export class CaptureStudioWindow {
  constructor(
    private readonly context: CaptureWindowContext,
    private readonly host: CaptureWindowHost,
    private readonly resources: CaptureWindowResources,
    private readonly document: Document,
    private readonly window: Window,
    private readonly report: (error: unknown) => void,
  ) {}

  async mount(selector = '#app'): Promise<App> {
    await this.context.initialize();
    const app = createApp(CaptureStudio);
    const effects = new CameraEffectsComposition(
      this.resources.directory,
      filename => this.resources.loadRuntime(filename),
      filename => this.resources.readModel(filename),
      this.document, this.window, this.report,
    );
    app.provide(cameraEffectsKey, effects.effects);
    await this.host.install(app);
    app.mount(selector);

    return app;
  }
}
