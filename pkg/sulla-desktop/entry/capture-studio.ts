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
const nativeRequire = createRequire(path.join(process.resourcesPath, 'ce1-native.cjs'));
const cameraEffects = new CameraEffectsComposition(paths.resources, nativeRequire, filename => readFile(filename), document, window, error => console.warn('[CameraEffects]', error));
app.provide(cameraEffectsKey, cameraEffects.effects);

app.use(store);
await usePlugins(app, store);

app.mount('#app');
