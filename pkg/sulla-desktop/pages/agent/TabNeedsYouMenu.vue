<!-- Sulla Desktop · https://sulladesktop.com
     Copyright (c) 2025-2026 Merchant Protocol LLC.
     SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <div
    v-if="tabs.length"
    ref="menuRoot"
    class="tab-needs-menu"
    @pointerdown.stop
    @keydown.esc.prevent.stop="closeMenu(true)"
  >
    <button
      ref="triggerButton"
      class="tab-needs-button"
      type="button"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      @click="isOpen = !isOpen"
    >
      Needs you
      <span class="tab-needs-count">{{ count }}</span>
    </button>
    <div
      v-if="isOpen"
      class="tab-needs-list"
      role="listbox"
      aria-label="Waiting on you"
    >
      <div class="tab-needs-heading">
        Waiting on you
      </div>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab-needs-row"
        type="button"
        role="option"
        @click="selectTab(tab.id)"
      >
        <span
          class="tab-needs-dot"
          :class="`tab-needs-dot-${tab.activity}`"
          aria-hidden="true"
        />
        <span class="tab-needs-copy">
          <span class="tab-needs-title">{{ tab.label }}</span>
          <span class="tab-needs-status">{{ tab.statusLine }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';

interface NeedsYouTab {
  id:         string;
  label:      string;
  statusLine: string;
  activity?:  string;
}

defineProps<{ tabs: NeedsYouTab[]; count: number }>();
const isOpen = ref(false);
const menuRoot = ref<HTMLElement | null>(null);
const triggerButton = ref<HTMLButtonElement | null>(null);

const emit = defineEmits<{ select: [id: string]; 'open-change': [open: boolean] }>();
watch(isOpen, open => emit('open-change', open), { flush: 'sync' });

function closeMenu(restoreFocus = false): void {
  isOpen.value = false;
  if (restoreFocus) triggerButton.value?.focus();
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (event.target instanceof Node && !menuRoot.value?.contains(event.target)) closeMenu();
}

function selectTab(id: string): void {
  closeMenu();
  emit('select', id);
}

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown));
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  if (isOpen.value) emit('open-change', false);
});
</script>

<style scoped>
.tab-needs-menu { position: relative; z-index: 8; flex: none; }
.tab-needs-button {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px 0 8px;
  border: 1px solid color-mix(in srgb, var(--status-warning) 40%, transparent); border-radius: 999px;
  color: var(--status-warning); background: color-mix(in srgb, var(--status-warning) 10%, transparent);
  font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer;
}
.tab-needs-button:hover { background: color-mix(in srgb, var(--status-warning) 16%, transparent); }
.tab-needs-count {
  display: grid; place-items: center; min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 999px; color: var(--bg-surface); background: var(--status-warning); font-size: 10px;
}
.tab-needs-list {
  position: absolute; top: 30px; left: 0; width: min(320px, calc(100vw - 32px)); max-height: 360px;
  overflow-y: auto; padding: 5px; border: 1px solid var(--border-default); border-radius: 12px;
  color: var(--text-primary); background: var(--bg-elevated, var(--bg-surface)); box-shadow: var(--elev-raised, 0 10px 32px color-mix(in srgb, var(--text-primary) 16%, transparent));
}
.tab-needs-heading { padding: 8px 10px 6px; color: var(--text-muted); font-size: 11px; font-weight: 700; }
.tab-needs-row {
  display: flex; align-items: flex-start; gap: 9px; width: 100%; padding: 8px 10px; border: 0;
  border-radius: 8px; color: inherit; background: transparent; text-align: left; cursor: pointer;
}
.tab-needs-row:hover, .tab-needs-row:focus-visible { background: var(--bg-surface-hover); outline: none; }
.tab-needs-dot { flex: 0 0 8px; width: 8px; height: 8px; margin-top: 4px; border-radius: 50%; background: var(--status-warning); }
.tab-needs-dot-stalled { background: var(--status-error); }
.tab-needs-copy { display: grid; gap: 3px; min-width: 0; }
.tab-needs-title { overflow: hidden; color: var(--text-primary); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.tab-needs-status { overflow: hidden; color: var(--text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
</style>
