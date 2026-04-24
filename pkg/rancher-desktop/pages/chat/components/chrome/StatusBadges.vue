<!--
  Top-right status: connection state + active model (clickable to swap).
-->
<template>
  <div class="top-right">
    <div :class="['badge', connectionClass]">
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
  return s === 'online' ? 'Online' : s === 'degraded' ? 'Degraded' : 'Offline';
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
}
.badge.model {
  color: var(--steel-300); cursor: pointer;
}
.badge.model:hover { color: var(--steel-100); border-color: var(--steel-400); }
.badge .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ok); box-shadow: 0 0 8px var(--ok);
}
.badge.degraded .dot { background: var(--warn); box-shadow: 0 0 8px var(--warn); animation: chat-pulse 1.5s infinite; }
.badge.offline  .dot { background: var(--err);  box-shadow: 0 0 8px var(--err);  animation: chat-pulse 1.5s infinite; }
.badge.model    .dot { background: var(--steel-400); box-shadow: 0 0 10px var(--steel-400); }
</style>
