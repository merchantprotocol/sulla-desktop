<template>
  <span
    :class="['file-status', state]"
    :title="label"
    :aria-label="label"
  >
    <svg
      v-if="state === 'online'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
    ><path d="M7 18a4 4 0 0 1-.5-7.96A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 7H7z" /></svg>
    <svg
      v-else-if="state === 'syncing'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    ><path d="M20 12a8 8 0 0 1-14.2 5M4 12a8 8 0 0 1 14.2-5" /><path d="M4 7v5h5M20 17v-5h-5" /></svg>
    <svg
      v-else-if="state === 'conflict'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    ><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.5v.01" /></svg>
    <svg
      v-else
      viewBox="0 0 24 24"
      fill="currentColor"
    ><circle
      cx="12"
      cy="12"
      r="9"
      opacity=".16"
    /><path
      d="M8 12.5l2.6 2.6L16.5 9"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    /></svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ state?: 'local' | 'online' | 'syncing' | 'conflict' }>(), { state: 'local' });
const label = computed(() => ({ local: 'Available in Files', online: 'Online only', syncing: 'Syncing', conflict: 'Sync conflict' })[props.state]);
</script>

<style scoped>
.file-status { width:18px;height:18px;display:inline-grid;place-items:center;flex:none;color:var(--ok) }
.file-status svg { width:14px;height:14px }
.file-status.online { color:var(--nx-read-4) }
.file-status.syncing { color:var(--nx-accent-2) }
.file-status.syncing svg { animation:chat-spin 1.6s linear infinite }
.file-status.conflict { color:var(--err) }
</style>
