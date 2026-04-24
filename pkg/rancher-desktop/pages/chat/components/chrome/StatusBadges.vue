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
      <span>{{ controller.model.value.name }} · ⌘K</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useChatController } from '../../controller/useChatController';

const controller = useChatController();

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
  font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.2em; text-transform: uppercase;
}
.badge {
  padding: 6px 12px; border-radius: 100px;
  background: rgba(20, 30, 42, 0.5);
  border: 1px solid rgba(168, 192, 220, 0.14);
  color: var(--read-3);
  display: inline-flex; align-items: center; gap: 8px;
  backdrop-filter: blur(8px);
  font: inherit; cursor: default;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
.badge.model {
  color: var(--steel-300); cursor: pointer;
}
.badge.model:hover { color: var(--steel-100); border-color: var(--steel-400); }
.badge .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ok); box-shadow: 0 0 8px var(--ok);
}
.badge.degraded {
  border-color: rgba(224, 182, 95, 0.35);
  animation: badge-glow 2.2s ease-in-out infinite;
}
.badge.degraded .dot { background: var(--warn); box-shadow: 0 0 8px var(--warn); animation: chat-pulse 1.5s infinite; }
.badge.offline {
  border-color: rgba(220, 95, 95, 0.35);
  animation: badge-glow-offline 1.8s ease-in-out infinite;
}
.badge.offline  .dot { background: var(--err);  box-shadow: 0 0 8px var(--err);  animation: chat-pulse 1.5s infinite; }
.badge.model    .dot { background: var(--steel-400); box-shadow: 0 0 10px var(--steel-400); }

@keyframes badge-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(224, 182, 95, 0.0); }
  50%      { box-shadow: 0 0 14px 0 rgba(224, 182, 95, 0.28); }
}
@keyframes badge-glow-offline {
  0%, 100% { box-shadow: 0 0 0 0 rgba(220, 95, 95, 0.0); }
  50%      { box-shadow: 0 0 14px 0 rgba(220, 95, 95, 0.30); }
}
</style>
