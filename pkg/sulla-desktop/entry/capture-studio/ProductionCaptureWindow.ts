// SPDX-License-Identifier: GPL-2.0-or-later
import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import path from 'path';

import Cookies from 'cookie-universal';
import type { App } from 'vue';

import type { CaptureWindowContext, CaptureWindowHost, CaptureWindowResources } from './CaptureStudioWindow';
import type { VisionRuntime } from '../../pages/capture-studio/effects/PersonInference';

import paths from '@pkg/utils/paths';

/** The existing personal-service initialization is unchanged and production-only. */
export class ProductionCaptureContext implements CaptureWindowContext {
  async initialize(): Promise<void> {
    const { initiateWindowContext } = await import('@pkg/sulla');
    await initiateWindowContext();
  }
}

export class ProductionCaptureHost implements CaptureWindowHost {
  async install(app: App): Promise<void> {
    const [{ default: store }, { default: usePlugins }] = await Promise.all([
      import('../store'), import('../plugins'),
    ]);
    (store as any).$cookies = Cookies();
    app.use(store);
    await usePlugins(app, store);
  }
}

export class ProductionCaptureResources implements CaptureWindowResources {
  readonly directory = paths.resources;
  private readonly nativeRequire = createRequire(path.join(process.resourcesPath, 'ce1-native.cjs'));

  loadRuntime(filename: string): VisionRuntime { return this.nativeRequire(filename); }
  readModel(filename: string): Promise<Uint8Array> { return readFile(filename); }
}
