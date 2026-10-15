<template>
  <div
    class="pkg"
    role="button"
    tabindex="0"
    @click="$emit('open')"
    @keydown.enter.self="$emit('open')"
  >
    <div class="pkg-ic">
      {{ pkg.icon }}
    </div>
    <div class="pkg-body">
      <h3>{{ pkg.title }}</h3>
      <p>{{ pkg.line }}</p>
      <div class="pkg-meta">
        <span class="pkg-name">{{ pkg.name }}</span>
        <span
          v-if="appBadge"
          class="pill"
        >{{ appBadge }}</span>
      </div>
    </div>
    <div class="pkg-act">
      <span
        v-if="installed"
        class="state ok"
      >✓ Installed</span>
      <button
        v-else
        type="button"
        class="getbtn"
        :disabled="busy"
        @click.stop="$emit('get')"
      >
        {{ busy ? 'Getting…' : 'Get' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { PackageRow } from '@pkg/composables/usePackages';

const props = defineProps<{
  pkg:       PackageRow;
  installed: boolean;
  busy:      boolean;
}>();

defineEmits<{
  (e: 'open'): void;
  (e: 'get'): void;
}>();

const appBadge = computed(() => {
  if (props.pkg.app === 'dashboard') return 'Includes a dashboard';
  if (props.pkg.app === 'app') return 'Includes an app';

  return '';
});
</script>

<style scoped>
.pkg {
  display: grid;
  grid-template-columns: 52px 1fr auto;
  gap: 16px;
  align-items: center;
  background: var(--nx-surface, var(--bg-surface));
  border: 1px solid var(--nx-hair-strong, var(--border-default));
  border-radius: 16px;
  padding: 18px 20px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s;
}
.pkg:hover,
.pkg:focus-visible {
  border-color: var(--nx-accent, var(--accent-primary));
  outline: none;
}
.pkg-ic {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: var(--nx-paper, var(--bg-page));
  display: grid;
  place-items: center;
  font-size: 26px;
}
.pkg h3 {
  margin: 0 0 2px;
  font-family: var(--font-body, system-ui, sans-serif);
  font-size: 17px;
  font-weight: 600;
  color: var(--nx-read-1, var(--text-primary));
}
.pkg p {
  margin: 0;
  font-size: 14px;
  line-height: 1.45;
  color: var(--nx-read-3, var(--text-muted));
}
.pkg-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}
.pkg-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--nx-read-2, var(--text-secondary));
}
.pill {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 999px;
  color: var(--nx-accent-2, var(--accent-primary));
  background: color-mix(in srgb, var(--nx-accent, var(--accent-primary)) 15%, transparent);
}
.getbtn {
  font: inherit;
  font-size: 14px;
  font-weight: 700;
  padding: 8px 18px;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  background: var(--nx-accent, var(--accent-primary));
  color: var(--text-on-accent, #fff);
  white-space: nowrap;
}
.getbtn:hover:not(:disabled) { background: var(--nx-accent-2, var(--accent-primary-hover)); }
.getbtn:disabled { opacity: 0.6; cursor: progress; }
.state {
  font-size: 13px;
  white-space: nowrap;
}
.state.ok {
  color: var(--nx-success, var(--text-success));
  font-weight: 600;
}

@container packages (max-width: 640px) {
  .pkg { grid-template-columns: 44px 1fr; }
  .pkg-ic { width: 44px; height: 44px; font-size: 22px; }
  .pkg-act { grid-column: 2; }
}
</style>
