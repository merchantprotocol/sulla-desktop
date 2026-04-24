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
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; cursor: pointer;
  background: rgba(20, 30, 42, 0.7);
  border: 1px solid rgba(168, 192, 220, 0.25);
  color: var(--read-2);
  backdrop-filter: blur(8px);
  transition: all 0.15s ease;
  display: inline-flex; align-items: center; gap: 8px;
}
.run-controls button:hover {
  border-color: var(--steel-400); color: white;
  background: rgba(80, 150, 179, 0.2);
}
.run-controls .stop::before {
  content: ""; width: 10px; height: 10px; border-radius: 2px;
  background: var(--err); box-shadow: 0 0 8px var(--err);
}
.run-controls .continue::before {
  content: "▸"; color: var(--steel-400); font-size: 13px;
}
</style>
