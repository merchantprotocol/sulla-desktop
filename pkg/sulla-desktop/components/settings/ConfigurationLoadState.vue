<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<script setup lang="ts">
defineProps<{ label: string; error?: string }>();
defineEmits<{ (event: 'retry'): void }>();
</script>

<template>
  <div class="configuration-load" :role="error ? 'alert' : 'status'">
    <span v-if="!error" class="spinner" aria-hidden="true" />
    <span>{{ error || label }}</span>
    <button v-if="error" type="button" @click="$emit('retry')">Retry</button>
  </div>
</template>

<style scoped>
.configuration-load { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: .75rem; min-height: 8rem; padding: 1rem; color: var(--text-secondary); text-align: center; }
.spinner { width: 1rem; height: 1rem; flex-shrink: 0; border: 2px solid var(--border-subtle); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
button { padding: .35rem .7rem; border: 1px solid var(--border-default); border-radius: .4rem; color: var(--text-primary); background: var(--bg-surface); }
@keyframes spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
