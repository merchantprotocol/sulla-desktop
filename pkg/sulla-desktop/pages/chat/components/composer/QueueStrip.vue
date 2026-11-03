<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Pending messages shown above the composer while a run is active. -->
<template>
  <div :class="['queue', { 'has-items': queue.length > 0 }]">
    <div class="qhead">
      <span>Pending</span>
      <span class="count">{{ queue.length }}</span>
      <button class="clear" type="button" @click="controller.clearQueue()">Clear all</button>
    </div>
    <div
      v-for="q in queue"
      :key="q.id"
      class="qitem"
    >
      <span class="text">{{ q.text }}</span>
      <button
        class="up"
        type="button"
        title="Move up"
        @click="controller.moveQueuedMessage(q.id, 'up')"
      >↑</button>
      <button
        class="down"
        type="button"
        title="Move down"
        @click="controller.moveQueuedMessage(q.id, 'down')"
      >↓</button>
      <button
        class="inject"
        type="button"
        title="Send now"
        @click="controller.injectQueuedMessage(q.id)"
      >▶</button>
      <button
        class="rm"
        type="button"
        title="Remove"
        @click="controller.removeQueuedMessage(q.id)"
      >✕</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useChatController } from '../../controller/useChatController';

const controller = useChatController();
const queue = computed(() => controller.queue.value);
</script>

<style scoped>
.queue {
  display: none; margin-bottom: 16px;
  padding: 12px 16px;
  border: 1px dashed var(--accent-glow);
  border-radius: 10px;
  background: var(--bg-surface, var(--accent-glow));
}
.queue.has-items { display: block; }
.qhead {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.25em;
  text-transform: uppercase; color: var(--accent, var(--accent-hover));
  margin-bottom: 10px; display: flex; align-items: center; gap: 12px;
}
.qhead .count {
  background: var(--accent-dim); color: var(--accent, var(--accent-hover));
  padding: 1px 7px; border-radius: 3px; font-size: 9.5px;
}
.qhead .clear {
  margin-left: auto; background: transparent; border: none;
  color: var(--text-muted, var(--text-muted)); font: inherit; cursor: pointer;
  letter-spacing: 0.2em;
}
.qhead .clear:hover { color: var(--status-error); }
.qitem {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 0; border-top: 1px solid var(--accent-dim);
  font-family: var(--font-display); font-style: italic; font-size: 14px;
  color: var(--text-secondary, var(--text-secondary));
}
.qitem:first-of-type { border-top: none; padding-top: 4px; }
.qitem .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qitem button {
  background: transparent; border: none; color: var(--text-muted, var(--text-muted));
  cursor: pointer; width: 24px; height: 24px; border-radius: 4px;
  font-family: var(--font-mono); font-size: 12px;
  transition: all 0.15s ease;
}
.qitem button:hover      { color: var(--accent, var(--accent-hover)); background: var(--accent-dim); }
.qitem .inject           { color: var(--status-success); font-size: 10px; }
.qitem .inject:hover     { color: var(--status-success); background: var(--status-success-soft); }
.qitem .rm:hover         { color: var(--status-error); background: var(--status-warning-soft); }
.queue {
  margin: 10px 0 0; padding: 8px 12px; border: 0; border-radius: 14px;
  color: var(--text-secondary); background: color-mix(in srgb, var(--border-default) 25%, transparent);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
  animation: noir-queue-in 0.42s cubic-bezier(.22, 1, .36, 1) both;
}
.qhead {
  margin-bottom: 4px; color: var(--text-dim); font-size: 10px; letter-spacing: 0.12em;
}
.qhead .count { color: var(--text-muted); background: var(--border-subtle); }
.qitem {
  padding: 5px 0; border-color: color-mix(in srgb, var(--border-default) 43.75%, transparent);
  color: var(--text-secondary); font-family: var(--font-body); font-size: 12.5px; font-style: normal;
}
@keyframes noir-queue-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .queue { animation: none; } }
</style>
