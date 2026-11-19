<!-- Sulla Desktop · https://sulladesktop.com
     Copyright (c) 2025-2026 Merchant Protocol LLC.
     SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <CaptureStudio />
</template>

<script setup lang="ts">
import { createRequire } from 'module';
import { readFile } from 'fs/promises';
import path from 'path';
import { provide } from 'vue';
import CaptureStudio from '../CaptureStudio.vue';
import { CameraEffectsComposition, cameraEffectsKey } from './effects/CameraEffectsComposition';
import paths from '@pkg/utils/paths';

// Preserve the native camera-effects runtime previously provided by the
// standalone entry point. The component stays mounted in its transferable tab.
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
    } catch { /* try the next runtime require */ }
  }
  return () => { throw new Error('No native require available for camera effects'); };
}

const cameraEffects = new CameraEffectsComposition(
  paths.resources,
  resolveNativeRequire(),
  filename => readFile(filename),
  document,
  window,
  error => console.warn('[CameraEffects]', error),
);
provide(cameraEffectsKey, cameraEffects.effects);
</script>
