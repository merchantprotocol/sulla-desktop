// SPDX-License-Identifier: GPL-2.0-or-later
import { createRequire } from 'module';
import { readFile } from 'fs/promises';
import path from 'path';

import { SyntheticMedia } from './SyntheticMedia';
import paths from './paths';
import { StrictRendererHost } from './StrictRendererHost';

class FixtureContext {
  constructor(private readonly media: SyntheticMedia) {}
  async initialize(): Promise<void> {
    new StrictRendererHost(require('electron').ipcRenderer).install();
    this.media.install();
    const { ipcRenderer } = require('electron');
    const fixture = await ipcRenderer.invoke('ce1:fixture-ready');
    if (fixture.identity !== 'ce1-strict-memory-v1') throw new Error('Incorrect fixture composition');
  }
}
class FixtureHost {
  async install(): Promise<void> {
    // The complete parent uses no shared store/plugins. Personal-service host installation is excluded.
    // Its settings/audio/RPC composables still use real Electron IPC into StrictFixtureRepository.
  }
}
class FixtureResources {
  readonly directory = paths.resources;
  private readonly nativeRequire = createRequire(path.join(process.resourcesPath, 'ce1-native.cjs'));
  loadRuntime(filename: string): any { return this.nativeRequire(filename); }
  readModel(filename: string): Promise<Uint8Array> { return readFile(filename); }
}
class VerificationEntry {
  async run(): Promise<void> {
    const media = new SyntheticMedia(document, navigator.mediaDevices);
    const context = new FixtureContext(media);
    // Synthetic providers must be installed BEFORE the parent module is even imported.
    await context.initialize();
    const { CaptureStudioWindow } = await import('../../pkg/sulla-desktop/entry/capture-studio/CaptureStudioWindow');
    const app = await new CaptureStudioWindow(
      { initialize: async() => { /* already initialized before imports */ } },
      new FixtureHost(), new FixtureResources(), document, window, error => console.warn('[CameraEffects]', error),
    ).mount();
    const { ipcRenderer } = require('electron');
    ipcRenderer.once('ce1:close', async() => {
      app.unmount(); media.close(); ipcRenderer.send('ce1:closed');
    });
    ipcRenderer.send('ce1:mounted');
  }
}
new VerificationEntry().run().catch(error => require('electron').ipcRenderer.send('ce1:failure', String(error.stack || error)));
