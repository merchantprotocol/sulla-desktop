<template>
  <div class="form">
    <section class="section">
      <h4>Metadata</h4>
      <MetadataFields
        :model-value="metadata"
        @update:model-value="onMetadataChange"
      />
    </section>

    <section class="section">
      <h4>Identity</h4>
      <div class="grid-2">
        <label class="f">
          <span class="l">Developer</span>
          <input
            type="text"
            :value="manifestField('developer')"
            placeholder="e.g. Acme Corp"
            @input="onField('developer', ($event.target as HTMLInputElement).value)"
          >
        </label>
        <label class="f">
          <span class="l">Icon filename</span>
          <input
            type="text"
            :value="manifestField('icon')"
            placeholder="acme.svg (must be bundled next to integration.yaml)"
            @input="onField('icon', ($event.target as HTMLInputElement).value)"
          >
        </label>
        <label class="f">
          <span class="l">Sort order</span>
          <input
            type="number"
            :value="manifestField('sort')"
            @input="onField('sort', Number(($event.target as HTMLInputElement).value) || 0)"
          >
        </label>
        <label class="f">
          <span class="l">Category</span>
          <select
            :value="manifestField('category')"
            @change="onField('category', ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="c in CATEGORIES"
              :key="c"
              :value="c"
            >
              {{ c }}
            </option>
          </select>
        </label>
      </div>
      <div class="grid-3">
        <label class="chk">
          <input
            type="checkbox"
            :checked="manifestField('paid') === true"
            @change="onField('paid', ($event.target as HTMLInputElement).checked)"
          >
          <span>Paid</span>
        </label>
        <label class="chk">
          <input
            type="checkbox"
            :checked="manifestField('beta') === true"
            @change="onField('beta', ($event.target as HTMLInputElement).checked)"
          >
          <span>Beta</span>
        </label>
        <label class="chk">
          <input
            type="checkbox"
            :checked="manifestField('comingSoon') === true"
            @change="onField('comingSoon', ($event.target as HTMLInputElement).checked)"
          >
          <span>Coming soon</span>
        </label>
      </div>
    </section>

    <section class="section">
      <h4>Authentication</h4>
      <div class="grid-2">
        <label class="f">
          <span class="l">Auth type</span>
          <select
            :value="manifestField('authType') || 'credentials'"
            @change="onField('authType', ($event.target as HTMLSelectElement).value)"
          >
            <option value="credentials">
              Credentials (form fields)
            </option>
            <option value="oauth">
              OAuth
            </option>
          </select>
        </label>
        <label
          v-if="manifestField('authType') === 'oauth'"
          class="f"
        >
          <span class="l">OAuth provider ID</span>
          <input
            type="text"
            :value="manifestField('oauthProviderId')"
            placeholder="e.g. google, slack"
            @input="onField('oauthProviderId', ($event.target as HTMLInputElement).value)"
          >
        </label>
      </div>
      <label
        v-if="manifestField('authType') === 'oauth'"
        class="chk"
      >
        <input
          type="checkbox"
          :checked="manifestField('sullaManagedOAuth') === true"
          @change="onField('sullaManagedOAuth', ($event.target as HTMLInputElement).checked)"
        >
        <span>Use Sulla-managed OAuth app (consumer-style identity)</span>
      </label>
    </section>

    <section class="section">
      <h4>Bundled artifacts</h4>
      <p class="hint">
        Declare companion functions and skills bundled with this integration. On install, bundled items are
        fanned out to <code>~/sulla/functions/&lt;slug&gt;-&lt;name&gt;/</code> and <code>~/sulla/skills/&lt;slug&gt;-&lt;name&gt;/</code>.
        The actual code for each bundled artifact must live under <code>functions/&lt;name&gt;/</code> or
        <code>skills/&lt;name&gt;/</code> in the integration package.
      </p>
      <div class="grid-2">
        <label class="f">
          <span class="l">Functions (comma-separated)</span>
          <input
            type="text"
            :value="bundledList('functions').join(', ')"
            placeholder="send, fetch, sync"
            @input="onBundledList('functions', ($event.target as HTMLInputElement).value)"
          >
        </label>
        <label class="f">
          <span class="l">Skills (comma-separated)</span>
          <input
            type="text"
            :value="bundledList('skills').join(', ')"
            placeholder="usage-guide"
            @input="onBundledList('skills', ($event.target as HTMLInputElement).value)"
          >
        </label>
      </div>
    </section>

    <section class="section">
      <h4>Advanced — integration.yaml</h4>
      <p class="hint">
        Properties, installation guide, media, and features are still edited raw here. Changes to the fields
        above rewrite the relevant keys on save; everything else in this YAML is preserved.
      </p>
      <textarea
        class="body-editor"
        :value="rawYaml"
        rows="20"
        spellcheck="false"
        @input="onRawYamlChange(($event.target as HTMLTextAreaElement).value)"
      />
      <p
        v-if="yamlError"
        class="err-hint"
      >
        YAML error: {{ yamlError }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import yaml from 'yaml';

import MetadataFields from './MetadataFields.vue';

const CATEGORIES = [
  'AI Infrastructure', 'AI & ML', 'Analytics', 'Automation', 'Communication',
  'CRM & Sales', 'Customer Support', 'Database', 'Design', 'Developer Tools',
  'E-Commerce', 'File Storage', 'Finance', 'HR & Recruiting', 'Marketing',
  'Paid Ads', 'Productivity', 'Project Management', 'Security', 'Social Media',
] as const;

interface DraftShape {
  manifest: Record<string, unknown>;
  files:    Record<string, string>;
}

const props = defineProps<{
  modelValue: DraftShape;
}>();

const emit = defineEmits<(e: 'update:modelValue', value: DraftShape) => void>();

const manifest = computed(() => props.modelValue?.manifest ?? {});
const metadata = computed(() => (manifest.value as any)?.metadata ?? {});

// The raw integration.yaml file is the source of truth for on-disk fields
// (authType, properties, bundled, etc). The sulla/v3 manifest is just UI
// scaffolding — we sync both sides on every change.
const rawYaml = computed(() => props.modelValue?.files?.['integration.yaml'] ?? '');

const yamlError = ref<string | null>(null);

const parsedYaml = computed<Record<string, unknown>>(() => {
  try {
    const parsed = yaml.parse(rawYaml.value);

    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
});

function manifestField(key: string): unknown {
  return parsedYaml.value[key];
}

function bundledList(kind: 'functions' | 'skills'): string[] {
  const bundled = parsedYaml.value.bundled as { functions?: unknown; skills?: unknown } | undefined;
  const value = bundled?.[kind];

  return Array.isArray(value) ? value.map(String) : [];
}

function onMetadataChange(next: Record<string, unknown>) {
  // Metadata fields mirror integration.yaml's name/description/version/tags.
  // We rewrite the YAML's top-level keys so the on-disk file stays the
  // source of truth; the v3 manifest is then regenerated from that.
  const yamlMutations: Record<string, unknown> = {};

  if (typeof next.name === 'string') yamlMutations.name = next.name;
  if (typeof next.description === 'string') yamlMutations.description = next.description;
  if (typeof next.version === 'string') yamlMutations.version = next.version;
  if (typeof next.category === 'string') yamlMutations.category = next.category;

  emitWithMutations(yamlMutations, { ...manifest.value, metadata: next });
}

function onField(key: string, value: unknown) {
  // `sort` is the only numeric field; everything else arrives as the
  // right type from the <input> handlers. Empty strings get cleared (so
  // users can unset optional fields like oauthProviderId).
  const cleaned = value === '' ? undefined : value;

  emitWithMutations({ [key]: cleaned });
}

function onBundledList(kind: 'functions' | 'skills', raw: string) {
  const list = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const existingBundled = (parsedYaml.value.bundled && typeof parsedYaml.value.bundled === 'object')
    ? { ...parsedYaml.value.bundled as Record<string, unknown> }
    : {};

  existingBundled[kind] = list.length > 0 ? list : undefined;

  // Drop `bundled` entirely when both arrays are empty.
  const nextBundled = (existingBundled.functions || existingBundled.skills) ? existingBundled : undefined;

  emitWithMutations({ bundled: nextBundled });
}

function onRawYamlChange(next: string) {
  try {
    yaml.parse(next);
    yamlError.value = null;
  } catch (err) {
    yamlError.value = err instanceof Error ? err.message : String(err);
  }
  // Still emit the edit so the user can save a half-finished YAML if they
  // want — the error surfaces inline but doesn't block.
  const files = { ...(props.modelValue?.files ?? {}) };

  files['integration.yaml'] = next;
  emit('update:modelValue', { manifest: props.modelValue.manifest, files });
}

/**
 * Apply a set of top-level YAML mutations (undefined values delete the key)
 * and emit the combined update. Optionally takes a pre-computed manifest
 * replacement; otherwise the manifest is kept as-is.
 */
function emitWithMutations(mutations: Record<string, unknown>, nextManifest?: Record<string, unknown>) {
  let doc: yaml.Document;

  try {
    doc = yaml.parseDocument(rawYaml.value);
    if (doc.errors.length > 0) doc = new yaml.Document({});
  } catch {
    doc = new yaml.Document({});
  }

  for (const [key, value] of Object.entries(mutations)) {
    if (value === undefined) {
      doc.delete(key);
    } else {
      doc.set(key, value);
    }
  }

  const files = { ...(props.modelValue?.files ?? {}) };

  files['integration.yaml'] = doc.toString();
  emit('update:modelValue', {
    manifest: nextManifest ?? props.modelValue.manifest,
    files,
  });
}

// When the draft loads/reloads from outside, revalidate the YAML so stale
// error messages clear.
watch(() => props.modelValue?.files?.['integration.yaml'], (next) => {
  if (typeof next !== 'string') return;
  try {
    yaml.parse(next);
    yamlError.value = null;
  } catch (err) {
    yamlError.value = err instanceof Error ? err.message : String(err);
  }
}, { immediate: true });
</script>

<style scoped lang="scss">
.form { display: flex; flex-direction: column; gap: 22px; }
.section h4 {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--steel-300);
  margin: 0 0 10px;
}
.hint {
  font-family: var(--sans);
  font-size: 11.5px;
  color: var(--steel-400);
  margin: 0 0 10px;
  line-height: 1.5;
  code {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--steel-200);
  }
}
.err-hint {
  font-family: var(--mono);
  font-size: 11px;
  color: #f87171;
  margin-top: 6px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px 16px;
  margin-top: 10px;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.l {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--steel-400);
}
.chk {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--sans);
  font-size: 12px;
  color: var(--steel-200);
  input[type='checkbox'] { accent-color: var(--steel-300); }
}
input, textarea, select {
  font-family: var(--sans);
  font-size: 13px;
  color: white;
  background: rgba(10, 18, 36, 0.6);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  outline: none;
}
input:focus, textarea:focus, select:focus {
  border-color: var(--steel-300);
}
.body-editor {
  width: 100%;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  min-height: 300px;
  resize: vertical;
}
</style>
