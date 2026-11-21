<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Separate run controls. Sending or queueing always stays on ComposerSend. -->
<template>
  <div
    v-if="visible"
    class="run-controls"
  >
    <div
      v-if="childStop.childCount.value || childStop.error.value"
      class="child-stop-popover"
      role="status"
    >
      <template v-if="childStop.childCount.value">
        <span><b>{{ childStop.childCount.value }}</b> sub-agent{{ childStop.childCount.value === 1 ? '' : 's' }} still running</span>
        <button
          type="button"
          class="kill-children"
          @click="killChildren"
        >
          Kill all
        </button>
      </template>
      <span v-else>{{ childStop.error.value }}</span>
      <button
        type="button"
        class="dismiss-children"
        aria-label="Dismiss"
        @click="childStop.dismiss()"
      >
        ×
      </button>
    </div>
    <button
      v-if="showStop"
      class="stop"
      type="button"
      aria-label="Stop Sulla"
      title="Stop Sulla"
      @click="stop"
    >
      <span
        aria-hidden="true"
        class="stop-square"
      />Stop
    </button>
    <button
      v-if="showContinue"
      class="continue"
      type="button"
      @click="controller.continueRun()"
    >
      Continue
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted } from 'vue';

import { ChildAgentStopController } from './ChildAgentStopController';
import { useChatController } from '../../controller/useChatController';
import { canContinue } from '../../models/RunState';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const controller = useChatController();
const childStop = new ChildAgentStopController(ipcRenderer);
const showStop = computed(() => controller.isRunning.value);
const showContinue = computed(() => canContinue(controller.runState.value));
const visible = computed(() => showStop.value || showContinue.value || childStop.childCount.value > 0 || !!childStop.error.value);

function activeThreadId(): string {
  return controller.thread.value.backendThreadId || controller.thread.value.id;
}

function stop(): void {
  controller.stop();
  childStop.inspect(activeThreadId()).catch(() => undefined);
}

async function killChildren(): Promise<void> {
  await childStop.kill(activeThreadId());
}

onUnmounted(() => childStop.dispose());
</script>

<style scoped>
.run-controls {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}
.run-controls button {
  min-height: 34px;
  padding: 0 11px;
  border: 1px solid var(--border-default);
  border-radius: 17px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--bg-surface) 88%, transparent);
  font: 600 11px/1 var(--font-body);
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
  display: inline-flex; align-items: center; gap: 8px;
}
.run-controls > .stop:hover {
  border-color: color-mix(in srgb, var(--status-error) 60%, var(--border-default));
  color: var(--text-primary);
  background: color-mix(in srgb, var(--status-error) 10%, var(--bg-surface));
}
.run-controls > .continue:hover {
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border-default));
  color: var(--text-primary);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface));
}
.stop-square {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--status-error);
}
.run-controls .continue::before {
  content: "▸"; color: var(--accent-hover); font-size: 13px;
}
.run-controls .continue {
  border-color: var(--border-default);
  color: var(--text-muted);
}
.child-stop-popover { position: absolute; right: 0; bottom: calc(100% + 10px); z-index: 30; display: flex; align-items: center; gap: 9px; width: max-content; max-width: min(360px, 80vw); padding: 9px 10px; border: 1px solid var(--border-default); border-radius: 10px; color: var(--text-primary); background: var(--bg-surface); box-shadow: 0 8px 24px color-mix(in srgb, var(--bg-page) 35%, transparent); font: 11px/1.35 var(--font-body); }
.child-stop-popover button { min-height: 0; padding: 0; border: 0; border-radius: 0; color: inherit; background: transparent; }
.child-stop-popover .kill-children { color: var(--status-error); font-weight: 700; white-space: nowrap; }
.child-stop-popover .dismiss-children { padding: 0 2px; color: var(--text-muted); font-size: 16px; line-height: 1; }
</style>
