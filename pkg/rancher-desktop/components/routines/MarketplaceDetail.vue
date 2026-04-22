<template>
  <div
    class="drawer-root"
    @click.self="$emit('close')"
  >
    <aside class="drawer">
      <header>
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
          <span class="chip">{{ sizeLabel }}</span>
        </div>
        <h2>{{ row.name }}</h2>
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
        <button
          type="button"
          class="close"
          aria-label="Close"
          @click="$emit('close')"
        >
          ✕
        </button>
      </header>

      <section class="meta-row">
        <div>
          <span class="label">Author</span>
          <span class="value">{{ authorDisplay }}</span>
        </div>
        <div>
          <span class="label">Installs</span>
          <span class="value">{{ row.download_count }}</span>
        </div>
        <div>
          <span class="label">Updated</span>
          <span class="value">{{ relativeUpdated }}</span>
        </div>
      </section>

      <section
        v-if="row.tags.length > 0"
        class="tags"
      >
        <span
          v-for="t in row.tags"
          :key="t"
          class="chip"
        >{{ t }}</span>
      </section>

      <section
        v-if="summaryItems.length > 0"
        class="summary"
      >
        <h3>What it needs</h3>
        <ul>
          <li
            v-for="item in summaryItems"
            :key="`${ item.label }-${ item.value }`"
          >
            <span class="label">{{ item.label }}</span>
            <span class="value">{{ item.value }}</span>
          </li>
        </ul>
      </section>

      <section
        v-if="readmePreview"
        class="preview"
      >
        <h3>README</h3>
        <pre class="readme">{{ readmePreview }}</pre>
      </section>

      <section
        v-if="coreDocPreview"
        class="preview"
      >
        <h3>{{ coreDocLabel }}</h3>
        <pre class="core-doc">{{ coreDocPreview }}</pre>
      </section>

      <section
        v-if="bundleFiles.length > 0"
        class="preview"
      >
        <h3>Bundle contents</h3>
        <ul class="files">
          <li
            v-for="f in bundleFiles"
            :key="f.path"
          >
            <span class="path">{{ f.path }}</span>
            <span class="bytes">{{ formatBytes(f.size) }}</span>
          </li>
        </ul>
      </section>

      <footer>
        <div
          v-if="installError || forkError"
          class="err"
        >
          {{ installError || forkError }}
        </div>
        <div
          v-if="installedInfo"
          class="ok"
        >
          Installed → <code>{{ installedInfo.path }}</code>
        </div>
        <div class="actions">
          <button
            type="button"
            class="btn ghost"
            @click="$emit('close')"
          >
            Close
          </button>

          <!-- Marketplace mode — Install into the local library -->
          <button
            v-if="source === 'marketplace'"
            type="button"
            class="btn primary"
            :disabled="installing || !!installedInfo"
            @click="$emit('install')"
          >
            {{ installButtonLabel }}
          </button>

          <!-- Local mode — Fork into an editable DB draft (skill/function/recipe only) -->
          <button
            v-else-if="row.kind !== 'routine'"
            type="button"
            class="btn primary"
            :disabled="forking"
            @click="$emit('fork')"
          >
            {{ forking ? 'Forking…' : `Fork ${ row.kind }` }}
          </button>
          <button
            v-else
            type="button"
            class="btn primary"
            :disabled="forking"
            @click="$emit('fork')"
          >
            {{ forking ? 'Instantiating…' : 'Use on canvas' }}
          </button>
        </div>
      </footer>
    </aside>
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

function readStringPath(obj: unknown, ...path: string[]): string | null {
  let cursor: any = obj;
  for (const key of path) {
    if (cursor == null || typeof cursor !== 'object') return null;
    cursor = cursor[key];
  }

  return typeof cursor === 'string' ? cursor : null;
}

const readmePreview = computed(() => readStringPath(props.manifest, 'previews', 'readme'));
const coreDocPreview = computed(() => readStringPath(props.manifest, 'previews', 'coreDoc'));

const coreDocLabel = computed(() => {
  switch (props.row.kind) {
  case 'routine':  return 'routine.yaml';
  case 'skill':    return 'SKILL.md';
  case 'function': return 'function.yaml';
  case 'recipe':   return 'recipe.yaml';
  default:         return 'core doc';
  }
});

const bundleFiles = computed<{ path: string; size: number }[]>(() => {
  const files = (props.manifest as any)?.bundle?.files;
  if (!Array.isArray(files)) return [];

  return files
    .filter(f => f && typeof f === 'object' && typeof f.path === 'string')
    .map(f => ({ path: f.path as string, size: Number(f.size) || 0 }));
});

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
    if (typeof s.edgeCount === 'number') items.push({ label: 'Edges', value: String(s.edgeCount) });
    addList('Triggers', s.triggerTypes);
    addList('Integrations', s.requiredIntegrations);
    addList('Functions', s.requiredFunctions);
    addList('Vault accounts', s.requiredVaultAccounts);
  }

  if (m?.skillSummary) {
    const s = m.skillSummary;
    if (typeof s.skillKey === 'string') items.push({ label: 'Skill key', value: s.skillKey });
    if (typeof s.category === 'string') items.push({ label: 'Category', value: s.category });
    if (typeof s.condition === 'string') items.push({ label: 'Condition', value: s.condition });
    if (typeof s.promptLength === 'number') items.push({ label: 'Prompt', value: `${ s.promptLength } chars` });
    addList('Integrations', s.requiredIntegrations);
  }

  if (m?.functionSummary) {
    const s = m.functionSummary;
    if (typeof s.functionName === 'string') items.push({ label: 'Function', value: s.functionName });
    if (typeof s.runtime === 'string') items.push({ label: 'Runtime', value: s.runtime });
    if (typeof s.entrypoint === 'string') items.push({ label: 'Entrypoint', value: s.entrypoint });
    if (Array.isArray(s.inputs)) items.push({ label: 'Inputs', value: String(s.inputs.length) });
    if (Array.isArray(s.outputs)) items.push({ label: 'Outputs', value: String(s.outputs.length) });
    addList('Vault accounts', s.requiredVaultAccounts);
  }

  if (m?.recipeSummary) {
    const s = m.recipeSummary;
    if (typeof s.extension === 'string') items.push({ label: 'Extension', value: s.extension });
    if (typeof s.extensionVersion === 'string') items.push({ label: 'Version range', value: s.extensionVersion });
    if (Array.isArray(s.dependencies)) {
      items.push({
        label: 'Dependencies',
        value: s.dependencies
          .map((d: any) => (typeof d?.extension === 'string' ? d.extension : null))
          .filter(Boolean)
          .join(', ') || '—',
      });
    }
    addList('Config keys', s.configKeys);
  }

  return items;
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

const installButtonLabel = computed(() => {
  if (props.installedInfo) return 'Installed ✓';
  if (props.installing)    return 'Installing…';

  return `Install ${ props.row.kind }`;
});
</script>

<style scoped lang="scss">
.drawer-root {
  position: fixed;
  inset: 0;
  background: rgba(4, 8, 16, 0.62);
  backdrop-filter: blur(6px);
  z-index: 40;
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: min(720px, 100%);
  max-height: 100vh;
  overflow-y: auto;
  background: linear-gradient(180deg, rgba(14, 22, 40, 0.98), rgba(8, 14, 28, 0.98));
  border-left: 1px solid rgba(168, 192, 220, 0.2);
  padding: 28px 32px 80px;
  position: relative;
  color: var(--steel-100, white);
}
header { position: relative; margin-bottom: 22px; }
.close {
  position: absolute;
  top: -6px;
  right: -6px;
  background: transparent;
  border: none;
  color: var(--steel-300);
  font-size: 18px;
  cursor: pointer;
  padding: 6px 10px;
}
.close:hover { color: white; }

.kicker {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
h2 {
  font-family: var(--serif);
  font-style: italic;
  font-size: 32px;
  line-height: 1.1;
  color: white;
  margin: 0 0 8px;
}
.tagline {
  font-family: var(--serif);
  font-style: italic;
  font-size: 15px;
  color: var(--steel-200);
  line-height: 1.4;
  margin: 0 0 10px;
}
.desc {
  font-family: var(--sans);
  font-size: 13px;
  color: var(--steel-200);
  line-height: 1.6;
  margin: 0;
}

.meta-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  padding: 14px 16px;
  background: rgba(10, 18, 36, 0.5);
  border: 1px solid var(--line);
  border-radius: 4px;
  margin-bottom: 16px;
}
.meta-row > div { display: flex; flex-direction: column; gap: 2px; }
.meta-row .label {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--steel-400);
}
.meta-row .value {
  font-family: var(--sans);
  font-size: 14px;
  color: white;
}

.tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.summary { margin-bottom: 24px; }
.summary h3,
.preview h3 {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--steel-300);
  margin: 0 0 10px;
}
.summary ul { list-style: none; padding: 0; margin: 0; }
.summary li {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px dashed rgba(168, 192, 220, 0.15);
  font-size: 12.5px;
}
.summary .label {
  color: var(--steel-300);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
.summary .value { color: white; word-break: break-word; }

.preview {
  margin-bottom: 22px;
  max-height: 420px;
  overflow: auto;
}
.preview pre {
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--steel-100);
  background: rgba(4, 8, 18, 0.8);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 12px 14px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.files { list-style: none; padding: 0; margin: 0; }
.files li {
  display: flex;
  justify-content: space-between;
  padding: 5px 0;
  font-family: var(--mono);
  font-size: 11px;
  border-bottom: 1px dashed rgba(168, 192, 220, 0.1);
}
.files .path { color: var(--steel-100); }
.files .bytes { color: var(--steel-400); }

footer {
  position: sticky;
  bottom: 0;
  margin-top: 16px;
  padding-top: 16px;
  background: linear-gradient(180deg, transparent, rgba(8, 14, 28, 0.98) 20%);
}
footer .err {
  color: #f87171;
  font-family: var(--sans);
  font-size: 12.5px;
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid rgba(248, 113, 113, 0.3);
  background: rgba(127, 29, 29, 0.2);
  border-radius: 4px;
}
footer .ok {
  color: #86efac;
  font-family: var(--sans);
  font-size: 12.5px;
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid rgba(134, 239, 172, 0.3);
  background: rgba(4, 58, 34, 0.25);
  border-radius: 4px;
}
footer .ok code { font-family: var(--mono); font-size: 11px; color: #a7f3d0; }
.actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
.btn {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 9px 18px;
  border-radius: 4px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.btn.primary {
  background: linear-gradient(135deg, var(--steel-300), var(--steel-500));
  color: white;
  border-color: var(--steel-400);
}
.btn.primary:disabled { opacity: 0.55; cursor: not-allowed; }
.btn.ghost {
  background: transparent;
  color: var(--steel-200);
  border-color: rgba(168, 192, 220, 0.3);
}
.btn.ghost:hover { border-color: var(--steel-300); color: white; }

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
