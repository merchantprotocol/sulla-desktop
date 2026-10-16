<template>
  <header class="pv2-header">
    <button
      type="button"
      class="pv2-back"
      aria-label="Back to projects"
      @click="$emit('back-to-list')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
    </button>
    <span
      class="pv2-mark"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><rect
        x="3.5"
        y="4"
        width="17"
        height="16"
        rx="2.5"
      /><path d="M9 4v16M15 4v16" /></svg>
    </span>
    <div class="pv2-heading">
      <h1>{{ title }}</h1>
      <span v-if="meta">{{ meta }}</span>
    </div>
    <div class="pv2-spacer" />
    <button
      v-if="canAdd"
      type="button"
      class="pv2-add"
      @click="$emit('add-card')"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
      ><path d="M12 5v14M5 12h14" /></svg>
      Add card
    </button>
    <div
      class="pv2-switch"
      aria-label="Project view"
    >
      <button
        type="button"
        :class="{ active: activeView === 'board' }"
        :aria-pressed="activeView === 'board'"
        @click="$emit('view-change', 'board')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        ><rect
          x="3.5"
          y="4"
          width="17"
          height="16"
          rx="2.5"
        /><path d="M9 4v16M15 4v16" /></svg>
        Board
      </button>
      <button
        type="button"
        :class="{ active: activeView === 'table' }"
        :aria-pressed="activeView === 'table'"
        @click="$emit('view-change', 'table')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        ><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>
        Table
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  title:      string;
  meta?:      string;
  activeView: 'board' | 'table';
  canAdd?:    boolean;
}>();

defineEmits<{
  (event: 'back-to-list'): void;
  (event: 'add-card'): void;
  (event: 'view-change', view: 'board' | 'table'): void;
}>();
</script>

<style scoped>
.pv2-header { display: flex; align-items: center; gap: 10px; min-height: 42px; margin-bottom: 14px; }
.pv2-back, .pv2-add, .pv2-switch button { border: 1px solid var(--border, rgba(26, 35, 50, .14)); color: var(--text, #1a2332); background: var(--surface-1, #fff); font: inherit; cursor: pointer; }
.pv2-back { width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border-radius: 8px; }
.pv2-back svg, .pv2-add svg, .pv2-switch svg { width: 14px; height: 14px; }
.pv2-back:hover, .pv2-add:hover { color: var(--accent, #3a7fa0); border-color: color-mix(in srgb, var(--accent, #3a7fa0) 35%, transparent); }
.pv2-mark { width: 28px; height: 28px; display: grid; place-items: center; flex: none; border-radius: 8px; color: #fff; background: var(--accent, #3a7fa0); }
.pv2-mark svg { width: 15px; height: 15px; }
.pv2-heading { min-width: 0; }
.pv2-heading h1 { margin: 0; overflow: hidden; color: var(--text, #1a2332); font-size: 20px; font-weight: 650; letter-spacing: -.01em; text-overflow: ellipsis; white-space: nowrap; }
.pv2-heading span { color: var(--text-dim, #8a94a3); font-size: 11.5px; }
.pv2-spacer { flex: 1; }
.pv2-add { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-color: var(--accent, #3a7fa0); border-radius: 8px; color: #fff; background: var(--accent, #3a7fa0); font-size: 12px; font-weight: 600; }
.pv2-switch { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--border, rgba(26, 35, 50, .14)); border-radius: 8px; background: var(--surface-1, #fff); }
.pv2-switch button { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border: 0; border-radius: 6px; color: var(--text-muted, #5b6778); background: transparent; font-size: 12px; }
.pv2-switch button.active { color: var(--accent, #2f6a86); background: color-mix(in srgb, var(--accent, #3a7fa0) 11%, transparent); font-weight: 600; }
@media (max-width: 700px) { .pv2-heading span { display: none; } .pv2-add { padding: 6px; font-size: 0; } .pv2-switch button { padding: 5px 7px; font-size: 0; } }
</style>
