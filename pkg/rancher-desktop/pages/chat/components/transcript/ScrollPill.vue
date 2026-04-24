<!-- Floating "jump to newest" pill that appears when scrolled up. -->
<template>
  <button v-if="visible" class="scroll-pill" type="button" @click="$emit('jump')">
    New messages
  </button>
</template>

<script setup lang="ts">
defineProps<{ visible: boolean }>();
defineEmits<{ (e: 'jump'): void }>();
</script>

<style scoped>
.scroll-pill {
  position: absolute; bottom: 220px; left: 50%;
  transform: translateX(-50%);
  padding: 8px 14px; border-radius: 100px;
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--steel-100);
  background: rgba(20, 30, 42, 0.85);
  border: 1px solid var(--steel-400);
  cursor: pointer; backdrop-filter: blur(10px);
  z-index: 16;
  box-shadow: 0 10px 30px rgba(0,0,0,0.4), 0 0 20px rgba(106, 176, 204, 0.15);
  display: inline-flex; align-items: center; gap: 8px;
  transition: all 0.2s ease;
}
.scroll-pill:hover { background: var(--steel-500); color: white; }
.scroll-pill::before { content: "↓"; font-size: 13px; }
</style>
