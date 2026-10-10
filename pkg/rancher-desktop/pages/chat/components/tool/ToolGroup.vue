<template>
  <section :class="['tool-group', { open }]">
    <button
      class="tool-group-head"
      type="button"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span
        :class="['tool-group-status', { running: hasRunning }]"
        aria-hidden="true"
      />
      <span>{{ messages.length }} tool {{ messages.length === 1 ? 'call' : 'calls' }}</span>
      <span class="tool-group-state">{{ stateLabel }}</span>
      <span
        class="tool-group-chevron"
        aria-hidden="true"
      >⌄</span>
    </button>
    <div class="tool-group-items">
      <ToolCall
        v-for="message in messages"
        :key="message.id"
        :msg="message"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import ToolCall from './ToolCall.vue';

import type { ToolMessage } from '../../models/Message';

const props = defineProps<{ messages: readonly ToolMessage[] }>();
const hasRunning = computed(() => props.messages.some(message => message.status === 'running'));
const hasError = computed(() => props.messages.some(message => message.status === 'error'));
const stateLabel = computed(() => hasRunning.value ? 'Running' : hasError.value ? 'Failed' : 'Done');
const open = ref(hasRunning.value);

watch(hasRunning, running => {
  if (running) open.value = true;
});
</script>

<style scoped>
.tool-group,
.tool-group-items {
  display: contents;
}
.tool-group-head {
  display: none;
}
</style>
