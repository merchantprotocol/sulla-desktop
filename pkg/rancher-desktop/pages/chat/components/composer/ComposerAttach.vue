<!-- Paperclip button — spawns the file-picker or a demo attachment. -->
<template>
  <button
    class="attach-btn"
    type="button"
    title="Attach a file"
    @click="$emit('pick')"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
    </svg>
  </button>
</template>

<script setup lang="ts">
defineEmits<{ (e: 'pick'): void }>();
</script>

<style scoped>
.attach-btn {
  width: 36px; height: 36px; border-radius: 50%;
  background: transparent;
  border: 1px solid rgba(168, 192, 220, 0.22);
  color: var(--read-3); font-size: 15px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0; align-self: center;
  transition: all 0.2s ease; padding: 0;
}
.attach-btn:hover {
  background: rgba(80, 150, 179, 0.18);
  border-color: var(--steel-400); color: var(--steel-400);
  box-shadow: 0 0 14px rgba(106, 176, 204, 0.3);
}
</style>
