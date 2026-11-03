<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Floating stop / continue buttons (shown when graph is running or paused). -->
<template>
  <div v-if="visible" class="run-controls">
    <button
      v-if="showStop"
      class="stop"
      type="button"
      @click="controller.stop()"
    >Stop · ESC</button>
    <button
      v-if="showContinue"
      class="continue"
      type="button"
      @click="controller.continueRun()"
    >Continue</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useChatController } from '../../controller/useChatController';
import { canContinue } from '../../models/RunState';

const controller = useChatController();
const showStop     = computed(() => controller.isRunning.value);
const showContinue = computed(() => canContinue(controller.runState.value));
const visible      = computed(() => showStop.value || showContinue.value);
</script>

<style scoped>
.run-controls {
  display: flex;
  position: absolute; top: -48px; right: 0;
  gap: 8px;
}
.run-controls button {
  padding: 8px 14px; border-radius: 100px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; cursor: pointer;
  background: var(--accent);
  border: 1px solid var(--accent-dim);
  color: var(--text-primary);
  backdrop-filter: blur(8px);
  transition: all 0.15s ease;
  display: inline-flex; align-items: center; gap: 8px;
}
.run-controls button:hover {
  border-color: var(--accent-hover); color: var(--text-on-accent);
  background: var(--accent-dim);
}
.run-controls .stop::before {
  content: ""; width: 10px; height: 10px; border-radius: 2px;
  background: var(--status-error); box-shadow: 0 0 8px var(--status-error);
}
.run-controls .continue::before {
  content: "▸"; color: var(--accent-hover); font-size: 13px;
}
.run-controls .stop { display: none; }
.run-controls {
  top: auto; right: 56px; bottom: 28px; z-index: 5;
}
.run-controls .continue {
  padding: 6px 10px; border-color: var(--border-default);
  color: var(--text-muted); background: var(--accent);
}
.run-controls .continue { background: color-mix(in srgb, var(--bg-surface) 90%, transparent); }
</style>
