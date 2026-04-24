<!-- Paperclip button — spawns the file-picker or a demo attachment. -->
<template>
  <button
    class="attach-btn"
    type="button"
    title="Attach a file"
    @click="$emit('pick')"
  >◇</button>
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
  background: rgba(80, 150, 179, 0.1);
  border-color: var(--steel-400); color: var(--steel-200);
}
</style>
