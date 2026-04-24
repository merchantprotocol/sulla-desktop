<!-- Mic / stop toggle (steel-blue). -->
<template>
  <button
    :class="['mic-btn', { live }]"
    type="button"
    :title="live ? 'Stop recording' : 'Start voice input (⌘/)'"
    @click="$emit('toggle')"
  >{{ live ? '■' : '◉' }}</button>
</template>

<script setup lang="ts">
defineProps<{ live?: boolean }>();
defineEmits<{ (e: 'toggle'): void }>();
</script>

<style scoped>
.mic-btn {
  width: 36px; height: 36px; border-radius: 50%;
  background: rgba(80, 150, 179, 0.08);
  border: 1px solid rgba(80, 150, 179, 0.28);
  color: var(--steel-300); font-size: 15px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0; align-self: center;
  transition: all 0.2s ease; padding: 0;
}
.mic-btn:hover {
  background: rgba(80, 150, 179, 0.18);
  border-color: var(--steel-400); color: var(--steel-400);
  box-shadow: 0 0 14px rgba(106, 176, 204, 0.3);
}
.mic-btn.live {
  background: var(--steel-500); border-color: var(--steel-400);
  color: white; animation: chat-pulse-glow 1.6s ease-in-out infinite;
}
</style>
