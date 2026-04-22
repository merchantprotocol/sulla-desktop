<template>
  <div
    class="strip"
    :class="{ featured: row.featured }"
    :data-kind="row.kind"
    @click="$emit('open')"
  >
    <div
      class="icon"
      :class="`kind-${row.kind}`"
    >
      {{ initials }}
    </div>

    <div class="body">
      <div class="top">
        <span
          class="kind-badge"
          :class="`kind-${row.kind}`"
        >{{ row.kind }}</span>
        <span class="chip">v{{ row.version }}</span>
        <span
          v-if="row.featured"
          class="chip featured-chip"
        >★ Featured</span>
      </div>
      <div class="title">
        {{ row.name }}
      </div>
      <div
        v-if="tagline"
        class="tagline"
      >
        {{ tagline }}
      </div>
      <div
        v-if="row.description"
        class="desc"
      >
        {{ row.description }}
      </div>
      <div
        v-if="row.tags.length > 0"
        class="meta"
      >
        <span
          v-for="tag in visibleTags"
          :key="tag"
          class="chip"
        >{{ tag }}</span>
        <span
          v-if="hiddenTagCount > 0"
          class="chip"
        >+{{ hiddenTagCount }}</span>
      </div>
    </div>

    <div class="metrics">
      <div class="metric">
        <b>{{ row.download_count }}</b><small>installs</small>
      </div>
      <div class="author">
        {{ authorDisplay }}
      </div>
      <div class="size">
        {{ sizeLabel }}
      </div>
    </div>

    <div
      class="cta"
      @click.stop
    >
      <button
        type="button"
        class="btn primary"
        @click="$emit('open')"
      >
        View
      </button>
      <button
        type="button"
        class="btn ghost"
        :disabled="installing || row.kind === 'recipe'"
        @click="$emit('install')"
      >
        {{ installButtonLabel }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

const props = defineProps<{
  row:        MarketplaceBrowseRow;
  installing: boolean;
}>();

defineEmits<{
  (e: 'open'): void;
  (e: 'install'): void;
}>();

const MAX_VISIBLE_TAGS = 3;

const initials = computed(() => {
  const source = props.row.name || props.row.slug || '??';
  const words = source.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return (words[0][0] + words[1][0]).toUpperCase();
});

const tagline = computed(() => props.row.tagline ?? null);

const visibleTags = computed(() => props.row.tags.slice(0, MAX_VISIBLE_TAGS));

const hiddenTagCount = computed(() => Math.max(0, props.row.tags.length - MAX_VISIBLE_TAGS));

const authorDisplay = computed(() => {
  if (props.row.author_display) return props.row.author_display;
  const suffix = props.row.author_contractor_id?.slice(-8) ?? '';

  return suffix ? `#${ suffix }` : 'Unknown';
});

const sizeLabel = computed(() => formatBytes(props.row.bundle_size));

function formatBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${ n } B`;
  if (n < 1024 * 1024) return `${ (n / 1024).toFixed(1) } KB`;

  return `${ (n / (1024 * 1024)).toFixed(2) } MB`;
}

const installButtonLabel = computed(() => {
  if (props.row.kind === 'recipe') return 'Website only';
  if (props.installing) return 'Installing…';

  return 'Install';
});
</script>

<style scoped lang="scss">
// Raised-card treatment ported from www-sulladesktop/marketplace.html —
// brighter surface, real drop shadow, and an always-visible kind-coloured
// left accent bar so cards read as distinct objects against the canvas.
.strip {
  display: grid;
  grid-template-columns: 64px 1fr 170px auto;
  gap: 24px;
  align-items: center;
  padding: 22px 24px 22px 27px;
  background: linear-gradient(135deg, rgba(30, 44, 72, 0.92), rgba(20, 32, 54, 0.88));
  border: 1px solid rgba(168, 192, 220, 0.22);
  border-radius: 8px;
  margin-bottom: 14px;
  position: relative;
  cursor: pointer;
  overflow: hidden;
  transition: background 0.2s, border-color 0.2s, transform 0.2s, box-shadow 0.2s;
  box-shadow:
    0 6px 18px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
.strip.featured {
  border-color: rgba(245, 158, 11, 0.5);
}
.strip:hover {
  border-color: rgba(196, 212, 230, 0.45);
  background: linear-gradient(135deg, rgba(40, 58, 92, 0.95), rgba(28, 44, 72, 0.92));
  transform: translateY(-2px);
  box-shadow:
    0 12px 32px rgba(0, 0, 0, 0.55),
    0 0 24px rgba(74, 111, 165, 0.18),
    inset 0 1px 0 rgba(255, 255, 255, 0.07);
}

// Left accent bar — kind-coloured, visible at rest. Fills to 4px on hover.
.strip::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  opacity: 0.55;
  transition: opacity 0.18s, width 0.18s;
}
.strip:hover::before { opacity: 1; width: 4px; }
.strip[data-kind="routine"]::before  { background: linear-gradient(180deg, #6b8fc4, #4a6fa5 50%, #2c4871); }
.strip[data-kind="skill"]::before    { background: linear-gradient(180deg, #fbbf24, #f59e0b 50%, #b45309); }
.strip[data-kind="function"]::before { background: linear-gradient(180deg, #5eead4, #14b8a6 50%, #0e7490); }
.strip[data-kind="recipe"]::before   { background: linear-gradient(180deg, #f472b6, #db2777 50%, #9d174d); }

// Top highlight hairline — catches the eye at the top edge.
.strip::after {
  content: '';
  position: absolute;
  top: 0; left: 24px; right: 24px; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(196, 212, 230, 0.25), transparent);
  pointer-events: none;
}

.icon {
  width: 56px; height: 56px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: white;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.icon.kind-routine  { background: linear-gradient(135deg, #2c4871, #4a6fa5); }
.icon.kind-skill    { background: linear-gradient(135deg, #d97706, #f59e0b); }
.icon.kind-function { background: linear-gradient(135deg, #0891b2, #06b6d4); }
.icon.kind-recipe   { background: linear-gradient(135deg, #a21caf, #c026d3); }

.body { min-width: 0; }
.top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.kind-badge {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: white;
}
.kind-badge.kind-routine  { background: rgba(74, 111, 165, 0.35); border-color: rgba(74, 111, 165, 0.6); }
.kind-badge.kind-skill    { background: rgba(245, 158, 11, 0.35); border-color: rgba(245, 158, 11, 0.6); }
.kind-badge.kind-function { background: rgba(6, 182, 212, 0.35);  border-color: rgba(6, 182, 212, 0.6); }
.kind-badge.kind-recipe   { background: rgba(192, 38, 211, 0.35); border-color: rgba(192, 38, 211, 0.6); }

.title {
  font-family: var(--serif);
  font-style: italic;
  font-size: 21px;
  color: white;
  line-height: 1.15;
  margin-bottom: 4px;
}
.tagline {
  font-family: var(--serif);
  font-style: italic;
  font-size: 13px;
  color: var(--steel-200);
  line-height: 1.35;
  margin-bottom: 6px;
}
.desc {
  font-family: var(--sans);
  font-size: 12.5px;
  color: var(--steel-200);
  line-height: 1.5;
  margin-bottom: 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.chip {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid rgba(168, 192, 220, 0.22);
  color: var(--steel-200);
  background: rgba(20, 30, 54, 0.4);
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.chip.featured-chip {
  border-color: rgba(245, 158, 11, 0.5);
  color: #f59e0b;
}

.metrics {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--steel-400);
  text-transform: uppercase;
  letter-spacing: 0.15em;
}
.metric b {
  font-family: var(--serif);
  font-style: italic;
  font-size: 24px;
  color: white;
  margin-right: 4px;
}
.metric small {
  font-size: 9px;
}
.author {
  color: var(--steel-200);
  text-transform: none;
  letter-spacing: 0;
  font-size: 11px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.size {
  color: var(--steel-400);
}

.cta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
  min-width: 140px;
}
.cta .btn {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  padding: 8px 14px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  text-transform: uppercase;
}
.cta .btn.primary {
  background: linear-gradient(135deg, var(--steel-300), var(--steel-500));
  color: white;
  border-color: var(--steel-400);
}
.cta .btn.primary:hover { filter: brightness(1.15); }
.cta .btn.ghost {
  background: transparent;
  color: var(--steel-200);
  border-color: rgba(168, 192, 220, 0.3);
}
.cta .btn.ghost:hover:not(:disabled) {
  border-color: var(--steel-300);
  color: white;
}
.cta .btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
