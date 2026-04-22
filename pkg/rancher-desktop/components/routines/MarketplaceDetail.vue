<template>
  <div class="page">
    <button
      type="button"
      class="back"
      @click="$emit('close')"
    >
      ← Back
    </button>

    <div class="hero">
      <div class="left">
        <div class="kicker">
          <span
            class="kind-badge"
            :class="`kind-${ row.kind }`"
          >{{ row.kind }}</span>
          <span class="chip">v{{ row.version }}</span>
          <span
            v-if="row.featured"
            class="chip featured-chip"
          >★ Featured</span>
        </div>
        <h1>{{ row.name }}</h1>
        <p
          v-if="row.tagline"
          class="tagline"
        >
          {{ row.tagline }}
        </p>
        <p
          v-if="row.description"
          class="desc"
        >
          {{ row.description }}
        </p>

        <div class="cta-row">
          <button
            v-if="source === 'marketplace'"
            type="button"
            class="btn primary big"
            :disabled="installing || !!installedInfo"
            @click="$emit('install')"
          >
            {{ installButtonLabel }}
          </button>
          <button
            v-else-if="row.kind !== 'routine'"
            type="button"
            class="btn primary big"
            :disabled="forking"
            @click="$emit('fork')"
          >
            {{ forking ? 'Forking…' : `Fork ${ row.kind }` }}
          </button>
          <button
            v-else
            type="button"
            class="btn primary big"
            :disabled="forking"
            @click="$emit('fork')"
          >
            {{ forking ? 'Instantiating…' : 'Use on canvas' }}
          </button>
        </div>

        <div
          v-if="installError || forkError"
          class="banner err"
        >
          {{ installError || forkError }}
        </div>
        <div
          v-if="installedInfo"
          class="banner ok"
        >
          Installed → <code>{{ installedInfo.path }}</code>
        </div>
      </div>

      <div
        class="right"
        :class="`kind-${ row.kind }`"
      >
        <img
          v-if="heroUrl"
          :src="heroUrl"
          :alt="row.name"
        >
        <div
          v-else
          class="hero-placeholder"
        >
          {{ initials }}
        </div>
      </div>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="label">
          Installs
        </div>
        <div class="value">
          {{ row.download_count }}
        </div>
      </div>
      <div class="stat">
        <div class="label">
          Author
        </div>
        <div class="value">
          {{ authorDisplay }}
        </div>
      </div>
      <div class="stat">
        <div class="label">
          Updated
        </div>
        <div class="value">
          {{ relativeUpdated }}
        </div>
      </div>
      <div class="stat">
        <div class="label">
          Size
        </div>
        <div class="value">
          {{ sizeLabel }}
        </div>
      </div>
    </div>

    <div
      v-if="row.tags.length > 0"
      class="tags"
    >
      <span
        v-for="t in row.tags"
        :key="t"
        class="chip"
      >{{ t }}</span>
    </div>

    <section
      v-if="summaryItems.length > 0"
      class="block"
    >
      <h3>What it needs</h3>
      <ul class="summary">
        <li
          v-for="item in summaryItems"
          :key="`${ item.label }-${ item.value }`"
        >
          <span class="label">{{ item.label }}</span>
          <span class="value">{{ item.value }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

const props = withDefaults(defineProps<{
  row:           MarketplaceBrowseRow;
  manifest:      Record<string, unknown>;
  source?:       'marketplace' | 'local';
  installing?:   boolean;
  installError?: string | null;
  installedInfo?: { kind: string; slug: string; path: string; name: string } | null;
  forking?:      boolean;
  forkError?:    string | null;
}>(), {
  source:        'marketplace',
  installing:    false,
  installError:  null,
  installedInfo: null,
  forking:       false,
  forkError:     null,
});

defineEmits<{
  (e: 'close'): void;
  (e: 'install'): void;
  (e: 'fork'): void;
}>();

const initials = computed(() => {
  const source = props.row.name || props.row.slug || '??';
  const words = source.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();

  return (words[0][0] + words[1][0]).toUpperCase();
});

const heroUrl = computed(() => {
  if (props.row.hero_media?.url) return props.row.hero_media.url;

  return null;
});

const authorDisplay = computed(() => {
  if (props.row.author_display) return props.row.author_display;
  const suffix = props.row.author_contractor_id?.slice(-8) ?? '';

  return suffix ? `#${ suffix }` : 'Unknown';
});

const sizeLabel = computed(() => formatBytes(props.row.bundle_size));

const relativeUpdated = computed(() => {
  if (!props.row.updated_at) return '—';
  const t = Date.parse(props.row.updated_at);
  if (!Number.isFinite(t)) return props.row.updated_at;
  const diffSec = Math.floor((Date.now() - t) / 1000);
  if (diffSec < 60)  return 'just now';
  if (diffSec < 3600) return `${ Math.floor(diffSec / 60) }m ago`;
  if (diffSec < 86400) return `${ Math.floor(diffSec / 3600) }h ago`;
  if (diffSec < 2592000) return `${ Math.floor(diffSec / 86400) }d ago`;

  return new Date(t).toISOString().slice(0, 10);
});

function formatBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${ n } B`;
  if (n < 1024 * 1024) return `${ (n / 1024).toFixed(1) } KB`;

  return `${ (n / (1024 * 1024)).toFixed(2) } MB`;
}

interface SummaryItem { label: string; value: string }

const summaryItems = computed<SummaryItem[]>(() => {
  const items: SummaryItem[] = [];
  const m = props.manifest as any;

  const addList = (label: string, list: unknown) => {
    if (Array.isArray(list) && list.length > 0) {
      items.push({ label, value: list.map(String).join(', ') });
    }
  };

  if (m?.routineSummary) {
    const s = m.routineSummary;
    if (typeof s.nodeCount === 'number') items.push({ label: 'Nodes', value: String(s.nodeCount) });
    addList('Triggers', s.triggerTypes);
    addList('Integrations', s.requiredIntegrations);
    addList('Functions', s.requiredFunctions);
  }
  if (m?.skillSummary) {
    const s = m.skillSummary;
    if (typeof s.category === 'string') items.push({ label: 'Category', value: s.category });
    if (typeof s.condition === 'string') items.push({ label: 'Condition', value: s.condition });
    addList('Integrations', s.requiredIntegrations);
  }
  if (m?.functionSummary) {
    const s = m.functionSummary;
    if (typeof s.runtime === 'string') items.push({ label: 'Runtime', value: s.runtime });
    if (Array.isArray(s.inputs)) items.push({ label: 'Inputs', value: String(s.inputs.length) });
    if (Array.isArray(s.outputs)) items.push({ label: 'Outputs', value: String(s.outputs.length) });
  }
  if (m?.recipeSummary) {
    const s = m.recipeSummary;
    if (typeof s.extension === 'string') items.push({ label: 'Extension', value: s.extension });
    if (typeof s.image === 'string') items.push({ label: 'Image', value: s.image });
  }

  return items;
});

const installButtonLabel = computed(() => {
  if (props.installedInfo) return 'Installed ✓';
  if (props.installing)    return 'Installing…';

  return `Install ${ props.row.kind }`;
});
</script>

<style scoped lang="scss">
.page {
  padding: 24px 8px 40px;
  color: var(--steel-100, white);
}

.back {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  background: transparent;
  border: 1px solid rgba(168, 192, 220, 0.3);
  color: var(--steel-200);
  padding: 7px 14px;
  border-radius: 4px;
  cursor: pointer;
  margin-bottom: 24px;
}
.back:hover { border-color: var(--steel-300); color: white; }

.hero {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 32px;
  align-items: center;
  margin-bottom: 32px;
  padding: 32px;
  background: linear-gradient(135deg, rgba(18, 28, 48, 0.7), rgba(10, 18, 36, 0.4));
  border: 1px solid var(--line);
  border-radius: 8px;
}

.kicker {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
h1 {
  font-family: var(--serif);
  font-style: italic;
  font-size: 46px;
  line-height: 1.05;
  color: white;
  margin: 0 0 12px;
}
.tagline {
  font-family: var(--serif);
  font-style: italic;
  font-size: 20px;
  color: var(--steel-200);
  line-height: 1.35;
  margin: 0 0 14px;
}
.desc {
  font-family: var(--sans);
  font-size: 14.5px;
  color: var(--steel-200);
  line-height: 1.65;
  margin: 0 0 24px;
}

.cta-row {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
.btn {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 10px 18px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: filter 0.15s;
}
.btn.big {
  font-size: 12px;
  padding: 14px 28px;
  letter-spacing: 0.18em;
}
.btn.primary {
  background: linear-gradient(135deg, var(--steel-300), var(--steel-500));
  color: white;
  border-color: var(--steel-400);
}
.btn.primary:hover:not(:disabled) { filter: brightness(1.15); }
.btn.primary:disabled { opacity: 0.55; cursor: not-allowed; }

.right {
  aspect-ratio: 16 / 10;
  border-radius: 6px;
  overflow: hidden;
  display: grid;
  place-items: center;
  border: 1px solid rgba(168, 192, 220, 0.18);
}
.right.kind-routine  { background: linear-gradient(135deg, #2c4871, #4a6fa5); }
.right.kind-skill    { background: linear-gradient(135deg, #d97706, #f59e0b); }
.right.kind-function { background: linear-gradient(135deg, #0891b2, #06b6d4); }
.right.kind-recipe   { background: linear-gradient(135deg, #a21caf, #c026d3); }
.right img { width: 100%; height: 100%; object-fit: cover; }
.hero-placeholder {
  font-family: var(--mono);
  font-size: 72px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.85);
  letter-spacing: 0.05em;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}
.stat {
  padding: 14px 16px;
  background: rgba(10, 18, 36, 0.5);
  border: 1px solid var(--line);
  border-radius: 4px;
}
.stat .label {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--steel-400);
  margin-bottom: 4px;
}
.stat .value {
  font-family: var(--serif);
  font-style: italic;
  font-size: 22px;
  color: white;
}

.tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 28px;
}

.block { margin-bottom: 28px; }
.block h3 {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--steel-300);
  margin: 0 0 12px;
}
.summary { list-style: none; padding: 0; margin: 0; }
.summary li {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px dashed rgba(168, 192, 220, 0.15);
  font-size: 13.5px;
}
.summary .label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--steel-300);
  padding-top: 2px;
}
.summary .value { color: white; word-break: break-word; }

.banner {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 4px;
  font-family: var(--sans);
  font-size: 13px;
}
.banner.err {
  color: #fca5a5;
  border: 1px solid rgba(248, 113, 113, 0.3);
  background: rgba(127, 29, 29, 0.2);
}
.banner.ok {
  color: #86efac;
  border: 1px solid rgba(134, 239, 172, 0.3);
  background: rgba(4, 58, 34, 0.25);
}
.banner code { font-family: var(--mono); font-size: 12px; color: #a7f3d0; }

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
}
.chip.featured-chip {
  border-color: rgba(245, 158, 11, 0.5);
  color: #f59e0b;
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
</style>
