// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * This is the entry point for the Capture Studio window.
 */

import { createRequire } from 'module';
import { readFile } from 'fs/promises';
import path from 'path';

import Cookies from 'cookie-universal';
import { createApp } from 'vue';

import usePlugins from './plugins';
import store from './store';
import CaptureStudio from '../pages/CaptureStudio.vue';

import { CameraEffectsComposition, cameraEffectsKey } from '../pages/capture-studio/effects/CameraEffectsComposition';
import paths from '@pkg/utils/paths';

import { initiateWindowContext } from '@pkg/sulla';
await initiateWindowContext();

(store as any).$cookies = Cookies();

const app = createApp(CaptureStudio);

// Native require is kept outside webpack's dynamic module resolution.
// Webpack can swap `module` for a stub whose createRequire is not a function
// (seen as "this.loadRuntime is not a function" -> blur always failed), so
// try createRequire first and fall back to the renderer's real require.
function resolveNativeRequire(): (filename: string) => any {
  const anchor = path.join(process.resourcesPath, 'ce1-native.cjs');
  const candidates: Array<() => unknown> = [
    () => createRequire(anchor),
    () => (window as any).require,
    // eslint-disable-next-line no-eval
    () => (0, eval)('require'),
  ];

  for (const candidate of candidates) {
    try {
      const found = candidate();

      if (typeof found === 'function') return found as (filename: string) => any;
    } catch { /* try the next one */ }
  }
  // Never break the whole window: effects report the failure and fall back to raw video.
  return () => { throw new Error('No native require available for camera effects'); };
}
const nativeRequire = resolveNativeRequire();
const cameraEffects = new CameraEffectsComposition(paths.resources, nativeRequire, filename => readFile(filename), document, window, error => console.warn('[CameraEffects]', error));
app.provide(cameraEffectsKey, cameraEffects.effects);

app.use(store);
await usePlugins(app, store);

app.mount('#app');
