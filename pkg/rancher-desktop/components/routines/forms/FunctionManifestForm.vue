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
      <h4>Function details</h4>
      <div class="grid-2">
        <label class="f">
          <span class="l">Runtime</span>
          <select
            :value="runtime"
            @change="onRuntime(($event.target as HTMLSelectElement).value as Runtime)"
          >
            <option value="python">python</option>
            <option value="node">node</option>
            <option value="shell">shell</option>
          </select>
        </label>
        <label class="f">
          <span class="l">Entry file</span>
          <input
            type="text"
            :value="entrypoint"
            :placeholder="defaultEntrypoint"
            @input="onEntrypoint(($event.target as HTMLInputElement).value)"
          >
        </label>
      </div>
    </section>

    <section class="section">
      <h4>Inputs</h4>
      <div
        v-for="(row, i) in inputRows"
        :key="`in-${ i }`"
        class="io-row"
      >
        <input
          type="text"
          :value="row.name"
          placeholder="name"
          @input="patchIo('inputs', i, 'name', ($event.target as HTMLInputElement).value)"
        >
        <input
          type="text"
          :value="row.type"
          placeholder="type (string, number, array…)"
          @input="patchIo('inputs', i, 'type', ($event.target as HTMLInputElement).value)"
        >
        <button
          type="button"
          class="btn-rm"
          @click="removeIo('inputs', i)"
        >
          ✕
        </button>
      </div>
      <button
        type="button"
        class="btn ghost small"
        @click="addIo('inputs')"
      >
        + Add input
      </button>
    </section>

    <section class="section">
      <h4>Outputs</h4>
      <div
        v-for="(row, i) in outputRows"
        :key="`out-${ i }`"
        class="io-row"
      >
        <input
          type="text"
          :value="row.name"
          placeholder="name"
          @input="patchIo('outputs', i, 'name', ($event.target as HTMLInputElement).value)"
        >
        <input
          type="text"
          :value="row.type"
          placeholder="type"
          @input="patchIo('outputs', i, 'type', ($event.target as HTMLInputElement).value)"
        >
        <button
          type="button"
          class="btn-rm"
          @click="removeIo('outputs', i)"
        >
          ✕
        </button>
      </div>
      <button
        type="button"
        class="btn ghost small"
        @click="addIo('outputs')"
      >
        + Add output
      </button>
    </section>

    <section class="section">
      <h4>{{ entrypoint || defaultEntrypoint }} — source</h4>
      <p class="hint">
        The runtime loads and invokes this file via HTTP. Keep it focused — the manifest describes the function's shape, this file implements it.
      </p>
      <textarea
        class="body-editor"
        :value="sourceCode"
        rows="22"
        spellcheck="false"
        @input="onSourceChange(($event.target as HTMLTextAreaElement).value)"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import MetadataFields from './MetadataFields.vue';

type Runtime = 'python' | 'node' | 'shell';
interface IoRow { name: string; type: string }

interface DraftShape {
  manifest: Record<string, unknown>;
  files:    Record<string, string>;
}

const props = defineProps<{
  modelValue: DraftShape;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: DraftShape): void;
}>();

const manifest = computed(() => props.modelValue?.manifest ?? {});
const metadata = computed(() => (manifest.value as any)?.metadata ?? {});
const summary  = computed(() => (manifest.value as any)?.functionSummary ?? {});

const runtime    = computed<Runtime>(() => (summary.value.runtime as Runtime) ?? 'python');
const entrypoint = computed(() => summary.value.entrypoint ?? defaultEntrypoint.value);
const defaultEntrypoint = computed(() => ({ python: 'main.py', node: 'main.js', shell: 'main.sh' } as Record<Runtime, string>)[runtime.value]);

const inputRows  = computed<IoRow[]>(() => normaliseIo(summary.value.inputs));
const outputRows = computed<IoRow[]>(() => normaliseIo(summary.value.outputs));

const sourceCode = computed(() => props.modelValue?.files?.[entrypoint.value] ?? '');

function normaliseIo(v: unknown): IoRow[] {
  if (!Array.isArray(v)) return [];

  return v.map((row) => ({
    name: String((row as any)?.name ?? ''),
    type: String((row as any)?.type ?? 'string'),
  }));
}

function onMetadataChange(next: Record<string, unknown>) {
  emit('update:modelValue', withManifest({ ...manifest.value, metadata: next }));
}

function onRuntime(next: Runtime) {
  const prevEntry = entrypoint.value;
  const nextEntry = summary.value.entrypoint && summary.value.entrypoint !== defaultEntrypoint.value
    ? summary.value.entrypoint
    : ({ python: 'main.py', node: 'main.js', shell: 'main.sh' } as Record<Runtime, string>)[next];

  const files = { ...(props.modelValue?.files ?? {}) };
  // Move the source file to the new entrypoint name so the user doesn't
  // lose their code when switching runtimes.
  if (files[prevEntry] && !files[nextEntry]) {
    files[nextEntry] = files[prevEntry];
    delete files[prevEntry];
  }

  const nextManifest = {
    ...manifest.value,
    functionSummary: { ...summary.value, runtime: next, entrypoint: nextEntry },
  };

  // Sync function.yaml file too so on-disk layout round-trips cleanly.
  files['function.yaml'] = serialiseFunctionYaml(nextManifest);

  emit('update:modelValue', { manifest: nextManifest, files });
}

function onEntrypoint(next: string) {
  const prevEntry = entrypoint.value;
  const files = { ...(props.modelValue?.files ?? {}) };
  if (files[prevEntry] !== undefined && next && next !== prevEntry) {
    files[next] = files[prevEntry];
    delete files[prevEntry];
  }
  const nextManifest = {
    ...manifest.value,
    functionSummary: { ...summary.value, entrypoint: next },
  };
  files['function.yaml'] = serialiseFunctionYaml(nextManifest);
  emit('update:modelValue', { manifest: nextManifest, files });
}

function patchIo(which: 'inputs' | 'outputs', index: number, key: 'name' | 'type', value: string) {
  const rows = [...(which === 'inputs' ? inputRows.value : outputRows.value)];
  rows[index] = { ...rows[index], [key]: value };
  setIo(which, rows);
}

function addIo(which: 'inputs' | 'outputs') {
  const rows = [...(which === 'inputs' ? inputRows.value : outputRows.value), { name: '', type: 'string' }];
  setIo(which, rows);
}

function removeIo(which: 'inputs' | 'outputs', index: number) {
  const rows = (which === 'inputs' ? inputRows.value : outputRows.value).filter((_, i) => i !== index);
  setIo(which, rows);
}

function setIo(which: 'inputs' | 'outputs', rows: IoRow[]) {
  emit('update:modelValue', withManifest({
    ...manifest.value,
    functionSummary: { ...summary.value, [which]: rows },
  }));
}

function onSourceChange(value: string) {
  const files = { ...(props.modelValue?.files ?? {}) };
  files[entrypoint.value] = value;
  emit('update:modelValue', { manifest: props.modelValue.manifest, files });
}

function withManifest(m: Record<string, unknown>): DraftShape {
  const files = { ...(props.modelValue?.files ?? {}) };
  files['function.yaml'] = serialiseFunctionYaml(m);

  return { manifest: m, files };
}

function serialiseFunctionYaml(m: Record<string, unknown>): string {
  const meta = (m as any).metadata ?? {};
  const sum  = (m as any).functionSummary ?? {};
  const lines: string[] = [];
  lines.push(`name: ${ quote(meta.name ?? '') }`);
  if (meta.description) lines.push(`description: ${ quote(meta.description) }`);
  if (meta.version)     lines.push(`version: ${ meta.version }`);
  if (meta.category)    lines.push(`category: ${ meta.category }`);
  lines.push(`runtime: ${ sum.runtime ?? 'python' }`);

  const emitIo = (key: 'inputs' | 'outputs') => {
    const rows = Array.isArray(sum[key]) ? sum[key] as IoRow[] : [];
    if (rows.length === 0) return;
    lines.push(`${ key }:`);
    for (const row of rows) {
      lines.push(`  ${ row.name || 'arg' }:`);
      lines.push(`    type: ${ row.type || 'string' }`);
    }
  };
  emitIo('inputs');
  emitIo('outputs');

  return `${ lines.join('\n') }\n`;
}

function quote(s: unknown): string {
  return JSON.stringify(String(s ?? ''));
}
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
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
.f { display: flex; flex-direction: column; gap: 4px; }
.l {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--steel-400);
}
input, select, textarea {
  font-family: var(--sans);
  font-size: 13px;
  color: white;
  background: rgba(10, 18, 36, 0.6);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  outline: none;
}
.io-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 8px;
  margin-bottom: 6px;
}
.btn-rm {
  background: transparent;
  border: 1px solid rgba(168, 192, 220, 0.22);
  color: var(--steel-400);
  border-radius: 4px;
  width: 34px;
  cursor: pointer;
}
.btn-rm:hover { color: #f87171; border-color: rgba(248, 113, 113, 0.35); }
.btn {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(168, 192, 220, 0.3);
  color: var(--steel-200);
}
.btn:hover { border-color: var(--steel-300); color: white; }
.body-editor {
  width: 100%;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  min-height: 340px;
  resize: vertical;
}
</style>
