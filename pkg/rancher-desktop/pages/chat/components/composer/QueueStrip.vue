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
  border: 1px dashed rgba(80, 150, 179, 0.3);
  border-radius: 10px;
  background: rgba(20, 30, 42, 0.4);
}
.queue.has-items { display: block; }
.qhead {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.25em;
  text-transform: uppercase; color: var(--steel-400);
  margin-bottom: 10px; display: flex; align-items: center; gap: 12px;
}
.qhead .count {
  background: rgba(80, 150, 179, 0.14); color: var(--steel-400);
  padding: 1px 7px; border-radius: 3px; font-size: 9.5px;
}
.qhead .clear {
  margin-left: auto; background: transparent; border: none;
  color: var(--read-4); font: inherit; cursor: pointer;
  letter-spacing: 0.2em;
}
.qhead .clear:hover { color: var(--err); }
.qitem {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 0; border-top: 1px solid rgba(80, 150, 179, 0.15);
  font-family: var(--serif); font-style: italic; font-size: 14px;
  color: var(--read-3);
}
.qitem:first-of-type { border-top: none; padding-top: 4px; }
.qitem .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qitem button {
  background: transparent; border: none; color: var(--read-4);
  cursor: pointer; width: 24px; height: 24px; border-radius: 4px;
  font-family: var(--mono); font-size: 12px;
  transition: all 0.15s ease;
}
.qitem button:hover      { color: var(--steel-400); background: rgba(80, 150, 179, 0.1); }
.qitem .inject           { color: var(--ok); font-size: 10px; }
.qitem .inject:hover     { color: var(--ok);  background: rgba(134, 239, 172, 0.1); }
.qitem .rm:hover         { color: var(--err); background: rgba(252, 165, 165, 0.1); }
</style>
