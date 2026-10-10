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
        :disabled="installing || installState === 'installed'"
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
  row:           MarketplaceBrowseRow;
  installing:    boolean;
  installState?: 'installed' | 'update' | null;
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
  const suffix = props.row.author_user_id?.slice(-8) ?? '';

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
  if (props.installing) return props.installState === 'update' ? 'Updating…' : 'Installing…';
  if (props.installState === 'installed') return 'Installed ✓';
  if (props.installState === 'update') return 'Update';

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

:global(.theme-noir) .strip {
  display: flex;
  min-height: 310px;
  margin: 0;
  padding: 20px;
  border-color: var(--nx-hair);
  border-radius: 20px;
  background:
    linear-gradient(155deg, color-mix(in srgb, var(--nx-accent) 7.5%, transparent), transparent 42%),
    color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.025), 0 12px 34px rgba(0, 0, 0, 0.18);
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  transition: transform 0.58s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1), border-color 0.2s, box-shadow 0.2s;
}

:global(.theme-noir) .strip::before {
  display: none;
}

:global(.theme-noir) .strip::after {
  left: 20px;
  right: 20px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--nx-accent-2) 26%, transparent), transparent);
}

:global(.theme-noir) .strip:hover {
  border-color: color-mix(in srgb, var(--nx-accent-2) 30%, transparent);
  background:
    linear-gradient(155deg, color-mix(in srgb, var(--nx-accent) 14%, transparent), transparent 48%),
    color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 4.5%, transparent);
  transform: translateY(-5px);
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.035), 0 22px 48px rgba(0, 0, 0, 0.34), 0 0 28px color-mix(in srgb, var(--nx-accent) 10%, transparent);
}

:global(.theme-noir) .icon {
  width: 58px;
  height: 58px;
  border-color: color-mix(in srgb, var(--nx-accent-2) 30%, transparent);
  border-radius: 16px;
  color: var(--nx-read-1);
  background: linear-gradient(135deg, color-mix(in srgb, var(--nx-accent-2) 34%, transparent), color-mix(in srgb, var(--nx-accent) 12%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 5%, transparent), 0 0 24px color-mix(in srgb, var(--nx-accent) 12%, transparent);
}

:global(.theme-noir) .icon[class*="kind-"] {
  background: linear-gradient(135deg, color-mix(in srgb, var(--nx-accent-2) 34%, transparent), color-mix(in srgb, var(--nx-accent) 12%, transparent));
}

:global(.theme-noir) .body {
  flex: 1;
}

:global(.theme-noir) .title {
  margin: 9px 0 7px;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 24px;
  font-style: normal;
  color: var(--nx-read-1);
}

:global(.theme-noir) .tagline,
:global(.theme-noir) .desc {
  color: var(--nx-read-3);
}

:global(.theme-noir) .kind-badge,
:global(.theme-noir) .chip {
  border-color: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent);
  border-radius: 9px;
  color: rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16));
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / 0.52);
}

:global(.theme-noir) .kind-badge[class*="kind-"] {
  border-color: color-mix(in srgb, var(--nx-accent-2) 22%, transparent);
  color: var(--nx-accent-2);
  background: color-mix(in srgb, var(--nx-accent) 10%, transparent);
}

:global(.theme-noir) .metrics {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: end;
  gap: 10px;
  padding-top: 13px;
  border-top: 1px solid color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 7%, transparent);
}

:global(.theme-noir) .metric b {
  font-family: 'Playfair Display', Georgia, serif;
  font-style: normal;
  color: var(--nx-read-1);
}

:global(.theme-noir) .author {
  justify-self: start;
  color: var(--nx-read-4);
}

:global(.theme-noir) .cta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-width: 0;
}

:global(.theme-noir) .cta .btn {
  min-height: 34px;
  border-radius: 17px;
  transition: transform 0.58s linear(0, .0258, .09, .1763, .2732, .3724, .4683, .5573, .6376, .7082, .7689, .8202, .8628, .8976, .9256, .9476, .9648, .9778, .9875, .9945, .9994, 1.0026, 1.0047, 1.0058, 1.0062, 1.0062, 1.0059, 1.0055, 1.0049, 1.0043, 1.0036, 1.0031, 1.0025, 1.002, 1.0016, 1.0013, 1), filter 0.2s;
}

:global(.theme-noir) .cta .btn:active {
  transform: scale(0.95);
}

:global(.theme-noir) .cta .btn.primary {
  border-color: color-mix(in srgb, var(--nx-accent-2) 45%, transparent);
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--nx-accent) 24%, transparent);
}

/* Noir Light softens dark-only elevation shadows for paper surfaces. */
:global(.theme-noir-light) .strip {
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.025), 0 12px 34px color-mix(in srgb, var(--nx-ink) 8%, transparent);
}
:global(.theme-noir-light) .strip:hover {
  box-shadow: inset 0 1px 0 rgb(from var(--nx-ink) calc(r + 12) calc(g + 10) calc(b + 7) / 0.035), 0 22px 48px color-mix(in srgb, var(--nx-ink) 14%, transparent), 0 0 28px color-mix(in srgb, var(--nx-accent) 10%, transparent);
}
</style>
