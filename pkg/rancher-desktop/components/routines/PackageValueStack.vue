<template>
  <div class="stack">
    <div
      v-for="(item, i) in stack.items"
      :key="i"
      class="srow"
    >
      <span>{{ item.label }}</span>
      <span
        v-if="item.elsewhere"
        class="cp"
      >{{ item.elsewhere }}</span>
    </div>
    <div
      v-if="stack.elsewhereTotal"
      class="srow tot"
    >
      <span>What you'd pay elsewhere</span>
      <span class="cp">{{ stack.elsewhereTotal }}</span>
    </div>
    <div
      v-if="stack.price"
      class="srow you"
    >
      <span>Your price with Sulla</span>
      <span>{{ stack.price }}</span>
    </div>
    <div
      v-if="installed"
      class="cta done"
    >
      ✓ Installed
    </div>
    <button
      v-else
      type="button"
      class="cta"
      :disabled="busy"
      @click="$emit('get')"
    >
      {{ busy ? 'Getting…' : (stack.cta || `YES! I want my ${name}!`) }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { PackagePageValueStack } from '@pkg/composables/packagePage';

defineProps<{
  stack:     PackagePageValueStack;
  name:      string;
  installed: boolean;
  busy:      boolean;
}>();

defineEmits<(e: 'get') => void>();
</script>

<style scoped>
.stack {
  margin-top: 26px;
  padding: 18px 20px;
  background: var(--nx-surface, var(--bg-surface));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 16px;
  box-shadow: 0 1px 2px var(--nx-hair, rgba(0, 0, 0, 0.06)), 0 12px 32px -12px var(--nx-hair-strong, rgba(0, 0, 0, 0.16));
}
.srow {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--nx-hair-strong, var(--border-default));
  font-size: 15px;
  line-height: 1.5;
  color: var(--nx-read-1, var(--text-primary));
}
.srow .cp {
  color: var(--nx-read-3, var(--text-muted));
  text-decoration: line-through;
  white-space: nowrap;
}
.srow.tot { font-weight: 700; }
.srow.you {
  border: 0;
  font-weight: 800;
  font-size: 18px;
  color: var(--nx-accent-2, var(--accent-primary));
}
.cta {
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  margin-top: 14px;
  padding: 12px 20px;
  font: inherit;
  font-size: 15px;
  font-weight: 700;
  border: 0;
  border-radius: 999px;
  background: var(--nx-accent, var(--accent-primary));
  color: var(--text-on-accent, #fff);
  cursor: pointer;
}
.cta:hover:not(:disabled):not(.done) { background: var(--nx-accent-2, var(--accent-primary-hover)); }
.cta:disabled { opacity: 0.6; cursor: progress; }
.cta.done {
  background: transparent;
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  color: var(--nx-success, var(--text-success));
  cursor: default;
}
</style>
