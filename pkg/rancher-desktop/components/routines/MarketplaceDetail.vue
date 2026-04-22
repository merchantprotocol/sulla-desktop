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
            :class="`kind-${row.kind}`"
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
            {{ forking ? 'Forking…' : `Fork ${row.kind}` }}
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
        :class="`kind-${row.kind}`"
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
          :key="`${item.label}-${item.value}`"
        >
          <span class="label">{{ item.label }}</span>
          <span class="value">{{ item.value }}</span>
        </li>
      </ul>
    </section>

    <section
      v-if="screenshots.length > 0"
      class="section accent-gallery"
    >
      <div class="section-head">
        <span class="section-num">Gallery</span>
        <h2 class="section-title">
          Screenshots
        </h2>
      </div>
      <div class="shots-grid">
        <figure
          v-for="(s, i) in screenshots"
          :key="i"
          class="shot"
        >
          <img
            :src="s.url"
            :alt="s.caption || ''"
            loading="lazy"
          >
          <figcaption v-if="s.caption">
            {{ s.caption }}
          </figcaption>
        </figure>
      </div>
    </section>

    <section
      v-if="readmeHtml"
      class="section accent-readme"
    >
      <div class="section-head">
        <span class="section-num">Act IV</span>
        <h2 class="section-title">
          Read me
        </h2>
      </div>
      <div
        class="panel"
        data-type="readme"
      >
        <button
          type="button"
          class="panel-head"
          @click="togglePanel('readme')"
        >
          <span class="panel-label">readme.md</span>
          <span
            v-if="readmeUpdatedLabel"
            class="panel-meta"
          >{{ readmeUpdatedLabel }}</span>
          <span
            class="chev"
            :class="{ open: isOpen('readme') }"
          >▾</span>
        </button>
        <div
          v-if="isOpen('readme')"
          class="panel-body"
        >
          <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify -->
          <div
            class="md"
            v-html="readmeHtml"
          />
        </div>
      </div>
    </section>

    <section
      v-if="coreDocText"
      class="section accent-code"
    >
      <div class="section-head">
        <span class="section-num">Act V</span>
        <h2 class="section-title">
          Core document
        </h2>
      </div>
      <div
        class="panel"
        data-type="coredoc"
      >
        <button
          type="button"
          class="panel-head"
          @click="togglePanel('coredoc')"
        >
          <span class="panel-label">{{ coreDocLabel }}</span>
          <span class="panel-meta">{{ row.kind }} source</span>
          <span
            class="chev"
            :class="{ open: isOpen('coredoc') }"
          >▾</span>
        </button>
        <div
          v-if="isOpen('coredoc')"
          class="panel-body"
        >
          <pre class="codeblock">{{ coreDocText }}</pre>
        </div>
      </div>
    </section>

    <section
      v-if="changelogHtml"
      class="section accent-changelog"
    >
      <div class="section-head">
        <span class="section-num">History</span>
        <h2 class="section-title">
          Changelog
        </h2>
      </div>
      <div
        class="panel"
        data-type="changelog"
      >
        <button
          type="button"
          class="panel-head"
          @click="togglePanel('changelog')"
        >
          <span class="panel-label">version history</span>
          <span class="panel-meta">markdown</span>
          <span
            class="chev"
            :class="{ open: isOpen('changelog') }"
          >▾</span>
        </button>
        <div
          v-if="isOpen('changelog')"
          class="panel-body"
        >
          <!-- eslint-disable-next-line vue/no-v-html -- sanitized via DOMPurify -->
          <div
            class="md"
            v-html="changelogHtml"
          />
        </div>
      </div>
    </section>

    <section
      v-if="bundleFiles.length > 0"
      class="section accent-tree"
    >
      <div class="section-head">
        <span class="section-num">Act VI</span>
        <h2 class="section-title">
          Bundle contents
        </h2>
      </div>
      <div
        class="panel"
        data-type="tree"
      >
        <button
          type="button"
          class="panel-head"
          @click="togglePanel('tree')"
        >
          <span class="panel-label">{{ bundleFiles.length }} file{{ bundleFiles.length === 1 ? '' : 's' }}</span>
          <span class="panel-meta">{{ bundleTotalLabel }}</span>
          <span
            class="chev"
            :class="{ open: isOpen('tree') }"
          >▾</span>
        </button>
        <div
          v-if="isOpen('tree')"
          class="panel-body"
        >
          <div class="tree">
            <div
              v-for="f in bundleFiles"
              :key="f.path"
              class="tree-row"
            >
              <span
                class="file"
                :class="fileClass(f.path)"
              >{{ f.path }}</span>
              <span class="size">{{ formatBytes(f.size) }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { computed, reactive } from 'vue';

import type { MarketplaceBrowseRow } from '@pkg/typings/electron-ipc';

const props = withDefaults(defineProps<{
  row:            MarketplaceBrowseRow;
  manifest:       Record<string, unknown>;
  source?:        'marketplace' | 'local';
  installing?:    boolean;
  installError?:  string | null;
  installedInfo?: { kind: string; slug: string; path: string; name: string } | null;
  forking?:       boolean;
  forkError?:     string | null;
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
  if (diffSec < 60) return 'just now';
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
  if (props.installing) return 'Installing…';

  return `Install ${ props.row.kind }`;
});

// ─── Detail sections (screenshots, README, core doc, changelog, file tree)
// Data lives on the manifest. The backend ships whatever it has; missing
// fields collapse each section away via v-if so the page stays clean.

interface Manifest {
  metadata?: { media?: { screenshots?: { url: string; caption?: string }[] }; changelog?: string };
  previews?: { readme?: string; readmeUpdatedAt?: string; coreDoc?: string };
  bundle?:   { files?: { path: string; size: number }[]; totalSize?: number };
}

const manifest = computed<Manifest>(() => (props.manifest ?? {}) as Manifest);

const screenshots = computed(() => manifest.value.metadata?.media?.screenshots ?? []);

function renderMarkdown(src: string | undefined): string {
  if (!src) return '';
  const html = marked.parse(src, { async: false });

  return DOMPurify.sanitize(html);
}

const readmeHtml = computed(() => renderMarkdown(manifest.value.previews?.readme));
const changelogHtml = computed(() => renderMarkdown(manifest.value.metadata?.changelog));

const readmeUpdatedLabel = computed(() => {
  const raw = manifest.value.previews?.readmeUpdatedAt;
  if (!raw) return '';
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return '';

  return `updated ${ new Date(t).toISOString().slice(0, 10) }`;
});

const coreDocText = computed(() => manifest.value.previews?.coreDoc ?? '');
const coreDocLabel = computed(() => {
  switch (props.row.kind) {
  case 'skill': return 'SKILL.md';
  case 'function': return 'function.yaml';
  case 'recipe': return 'compose.yaml';
  default: return 'routine.yaml';
  }
});

const bundleFiles = computed(() => manifest.value.bundle?.files ?? []);
const bundleTotalLabel = computed(() => {
  const total = manifest.value.bundle?.totalSize ??
    bundleFiles.value.reduce((acc, f) => acc + (f.size || 0), 0);

  return total > 0 ? formatBytes(total) : '—';
});

function fileClass(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('routine.yaml') || lower.endsWith('skill.md') ||
      lower.endsWith('function.yaml') || lower.endsWith('compose.yaml')) return 'core';
  if (lower.endsWith('readme.md')) return 'readme';

  return '';
}

// Collapsible panels — readme defaults open, the rest closed, mirroring
// the website's panel + panel.collapsed markup.
const panelState = reactive<Record<string, boolean>>({
  readme:    true,
  coredoc:   false,
  changelog: false,
  tree:      false,
});

function togglePanel(key: string) {
  panelState[key] = !panelState[key];
}

function isOpen(key: string): boolean {
  return !!panelState[key];
}
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

// ─── Detail sections — Gallery / README / Core doc / Changelog / Tree
// Shared section chrome: a numbered kicker + italic title with a coloured
// left accent bar keyed by section type. Ported from the website marketplace
// so the in-app detail view shows the same depth of information.
.section {
  padding: 36px 0 8px;
  margin-top: 12px;
}
.section + .section { padding-top: 18px; }
.section-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 20px;
  padding-left: 12px;
  border-left: 3px solid rgba(140, 172, 201, 0.4);
}
.section-num {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--steel-400);
}
.section-title {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 600;
  font-size: 28px;
  color: white;
  line-height: 1.1;
  margin: 0;
}

.section.accent-gallery   .section-head { border-left-color: rgba(196, 181, 253, 0.55); }
.section.accent-readme    .section-head { border-left-color: rgba(20, 184, 166, 0.55); }
.section.accent-code      .section-head { border-left-color: rgba(245, 158, 11, 0.55); }
.section.accent-changelog .section-head { border-left-color: rgba(167, 139, 250, 0.55); }
.section.accent-tree      .section-head { border-left-color: rgba(140, 172, 201, 0.55); }

// Screenshots grid.
.shots-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.shot {
  margin: 0;
  background: rgba(18, 28, 48, 0.55);
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  transition: border-color 0.18s, transform 0.18s;
}
.shot:hover { border-color: rgba(140, 172, 201, 0.45); transform: translateY(-2px); }
.shot img {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 16 / 10;
  object-fit: cover;
}
.shot figcaption {
  padding: 10px 14px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--steel-300);
  border-top: 1px solid var(--line);
}

// Collapsible panel used for README / core doc / changelog / tree.
.panel {
  background: linear-gradient(135deg, rgba(30, 44, 72, 0.8), rgba(20, 32, 54, 0.62));
  border: 1px solid rgba(168, 192, 220, 0.22);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 14px;
  position: relative;
}
.panel::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  opacity: 0.55;
}
.panel[data-type="readme"]::before    { background: linear-gradient(180deg, #5eead4, #0e7490); }
.panel[data-type="coredoc"]::before   { background: linear-gradient(180deg, #fbbf24, #b45309); }
.panel[data-type="changelog"]::before { background: linear-gradient(180deg, #c4b5fd, #7c3aed); }
.panel[data-type="tree"]::before      { background: linear-gradient(180deg, #a8c0dc, #4a6fa5); }

.panel-head {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px 20px 14px 22px;
  background: rgba(20, 30, 54, 0.45);
  border: none;
  border-bottom: 1px solid rgba(168, 192, 220, 0.18);
  cursor: pointer;
  color: inherit;
  text-align: left;
  transition: background 0.15s;
}
.panel-head:hover { background: rgba(28, 40, 68, 0.6); }
.panel-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  color: white;
  flex: 1;
}
.panel-meta {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--steel-400);
  text-transform: uppercase;
}
.chev {
  font-size: 14px;
  color: var(--steel-300);
  transition: transform 0.18s;
  transform: rotate(-90deg);
}
.chev.open { transform: rotate(0deg); }
.panel-body { padding: 18px 22px 20px; }

// Code block for the core document.
.codeblock {
  background: rgba(10, 18, 36, 0.7);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 16px 18px;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--steel-100);
  line-height: 1.6;
  max-height: 440px;
  overflow: auto;
  white-space: pre;
  margin: 0;
}

// Bundle file tree.
.tree {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.85;
  color: var(--steel-200);
}
.tree-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 12px;
  padding: 4px 10px;
  border-radius: 3px;
}
.tree-row:hover { background: rgba(168, 192, 220, 0.05); }
.tree-row .file { color: var(--steel-100); word-break: break-all; }
.tree-row .file.core   { color: #fde68a; }
.tree-row .file.readme { color: #99f6e4; }
.tree-row .size {
  color: var(--steel-400);
  font-size: 11px;
  white-space: nowrap;
}

// Rendered markdown inside README / changelog panels.
.md {
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.65;
  color: var(--steel-100);
}
.md :deep(h1),
.md :deep(h2),
.md :deep(h3) {
  font-family: var(--serif);
  font-style: italic;
  color: white;
  margin: 18px 0 10px;
}
.md :deep(h1) { font-size: 22px; }
.md :deep(h2) { font-size: 18px; }
.md :deep(h3) { font-size: 15px; letter-spacing: 0.02em; }
.md :deep(p) { margin: 0 0 12px; }
.md :deep(ul), .md :deep(ol) { margin: 0 0 12px 22px; padding: 0; }
.md :deep(li) { margin: 4px 0; }
.md :deep(code) {
  font-family: var(--mono);
  font-size: 12.5px;
  padding: 1px 6px;
  background: rgba(10, 18, 36, 0.6);
  border: 1px solid var(--line);
  border-radius: 3px;
  color: #fde68a;
}
.md :deep(pre) {
  background: rgba(10, 18, 36, 0.7);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 0 0 14px;
}
.md :deep(pre) :deep(code) {
  background: none;
  border: none;
  padding: 0;
  color: var(--steel-100);
}
.md :deep(a) { color: #99f6e4; }
.md :deep(blockquote) {
  border-left: 2px solid rgba(140, 172, 201, 0.35);
  padding: 2px 14px;
  margin: 0 0 12px;
  color: var(--steel-200);
}
</style>
