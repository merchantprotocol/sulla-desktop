<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Top-right status: connection state + active model (clickable to swap).

  Connection states come from controller.connection.value, set by the
  adapter based on backend health:
    'online'    → green dot,  "Online"
    'degraded'  → yellow dot, "Starting up…"  (model cold-starting)
    'offline'   → red dot,    "Offline"       (connection lost)
-->
<template>
  <div class="top-right">
    <div
      :class="['badge', connectionClass]"
      :title="connectionTitle"
    >
      <span class="dot" />
      <span>{{ connectionLabel }}</span>
    </div>
    <button class="badge model" type="button" @click="controller.openModal('model')">
      <span class="dot" />
      <span>{{ selectionLabel }} · ⌘K</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useChatController } from '../../controller/useChatController';
import { useSelectionLabel } from '../../composables/useSelectionLabel';

const controller = useChatController();
const { label: selectionLabel } = useSelectionLabel();

const connectionClass = computed(() => {
  const s = controller.connection.value;
  return s === 'online' ? '' : s;
});

const connectionLabel = computed(() => {
  const s = controller.connection.value;
  if (s === 'online')   return 'Online';
  if (s === 'degraded') return 'Starting up…';
  return 'Offline';
});

const connectionTitle = computed(() => {
  const s = controller.connection.value;
  if (s === 'degraded') return "Sulla is initializing — she'll be ready shortly";
  if (s === 'offline')  return 'Connection lost';
  return 'Connected';
});
</script>

<style scoped>
.top-right {
  position: absolute; top: 18px; right: 22px; z-index: 21;
  display: flex; align-items: center; gap: 12px;
  font-family: var(--font-mono); font-size: 10px;
  letter-spacing: 0.2em; text-transform: uppercase;
}
.badge {
  padding: 6px 12px; border-radius: 100px;
  background: var(--accent-glow);
  border: 1px solid var(--accent-dim);
  color: var(--text-secondary);
  display: inline-flex; align-items: center; gap: 8px;
  backdrop-filter: blur(8px);
  font: inherit; cursor: default;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
.badge.model {
  color: var(--accent-hover); cursor: pointer;
}
.badge.model:hover { color: var(--text-secondary); border-color: var(--accent-hover); }
.badge .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--status-success); box-shadow: 0 0 8px var(--status-success);
}
.badge.degraded {
  border-color: var(--status-warning);
  animation: badge-glow 2.2s ease-in-out infinite;
}
.badge.degraded .dot { background: var(--status-warning); box-shadow: 0 0 8px var(--status-warning); animation: chat-pulse 1.5s infinite; }
.badge.offline {
  border-color: var(--status-error);
  animation: badge-glow-offline 1.8s ease-in-out infinite;
}
.badge.offline  .dot { background: var(--status-error);  box-shadow: 0 0 8px var(--status-error);  animation: chat-pulse 1.5s infinite; }
.badge.model    .dot { background: var(--accent-hover); box-shadow: 0 0 10px var(--accent-hover); }

@keyframes badge-glow {
  0%, 100% { box-shadow: 0 0 0 0 var(--status-warning-soft); }
  50%      { box-shadow: 0 0 14px 0 var(--status-warning-soft); }
}
@keyframes badge-glow-offline {
  0%, 100% { box-shadow: 0 0 0 0 var(--status-error-soft); }
  50%      { box-shadow: 0 0 14px 0 var(--status-error); }
}
</style>
