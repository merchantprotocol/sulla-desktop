<!--
  Transcript — container. Iterates `controller.messages.value` and
  hands each to MessageRouter. Owns scroll behavior.
-->
<template>
  <div ref="scroller" class="scroller">
    <div class="chat-dialogue">
      <!-- Time marker for today (phase-0 scaffold) -->
      <TimeMarker v-if="showTodayMarker" :label="todayLabel" />

      <template v-for="m in controller.messages.value" :key="m.id">
        <MessageRouter :msg="m" />
      </template>
    </div>

    <ScrollPill :visible="showPill" @jump="scrollToBottom" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import MessageRouter from './MessageRouter.vue';
import ScrollPill    from './ScrollPill.vue';
import TimeMarker    from './TimeMarker.vue';
import { useChatController } from '../../controller/useChatController';
import { useScrollAnchor } from '../../composables/useScrollAnchor';

const controller = useChatController();
const scroller   = ref<HTMLElement | null>(null);

const { showPill, scrollToBottom } = useScrollAnchor(scroller, controller.messages);

const showTodayMarker = computed(() => controller.messages.value.length > 0);
const todayLabel = computed(() => {
  const d = new Date();
  const h = d.getHours() % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  return `Today · ${ h }:${ m } ${ ampm }`;
});

defineExpose({ scroller, scrollToBottom });
</script>

<style scoped>
.scroller {
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  overflow-y: auto; overflow-x: hidden;
  padding: 96px 12% var(--scroller-pad-b, 240px);
  scroll-behavior: smooth;
}
.scroller::-webkit-scrollbar { width: 8px; }
.scroller::-webkit-scrollbar-track { background: transparent; }
.scroller::-webkit-scrollbar-thumb { background: rgba(168, 192, 220, 0.18); border-radius: 4px; }
.scroller::-webkit-scrollbar-thumb:hover { background: rgba(168, 192, 220, 0.35); }
</style>
