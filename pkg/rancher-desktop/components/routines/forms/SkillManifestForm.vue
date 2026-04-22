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
      <h4>Skill details</h4>
      <div class="grid-2">
        <label class="f">
          <span class="l">Skill key</span>
          <input
            type="text"
            :value="skillKey"
            placeholder="e.g. handle_pricing_objection"
            @input="onSummary('skillKey', ($event.target as HTMLInputElement).value)"
          >
        </label>
        <label class="f">
          <span class="l">Condition</span>
          <input
            type="text"
            :value="condition"
            placeholder="always | when {...}"
            @input="onSummary('condition', ($event.target as HTMLInputElement).value)"
          >
        </label>
      </div>
    </section>

    <section class="section">
      <h4>SKILL.md body</h4>
      <p class="hint">
        The agent reads this content when the skill is loaded. Written in markdown. The YAML frontmatter up top is kept in sync with the fields above on save.
      </p>
      <textarea
        class="body-editor"
        :value="skillBody"
        rows="20"
        @input="onBodyChange(($event.target as HTMLTextAreaElement).value)"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import MetadataFields from './MetadataFields.vue';

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

const manifest  = computed(() => props.modelValue?.manifest ?? {});
const metadata  = computed(() => (manifest.value as any)?.metadata ?? {});
const skillSummary = computed(() => (manifest.value as any)?.skillSummary ?? {});

const skillKey  = computed(() => skillSummary.value.skillKey ?? '');
const condition = computed(() => skillSummary.value.condition ?? 'always');

const skillBody = computed(() => {
  const body = props.modelValue?.files?.['SKILL.md'] ?? '';
  // Strip any existing frontmatter so the editor surfaces the body only;
  // the frontmatter gets rebuilt on save from the form fields.
  if (body.startsWith('---')) {
    const close = body.indexOf('\n---', 3);
    if (close >= 0) return body.slice(close + 4).replace(/^\n/, '');
  }

  return body;
});

function onMetadataChange(next: Record<string, unknown>) {
  emit('update:modelValue', withManifest({ ...manifest.value, metadata: next }));
}

function onSummary(key: string, value: string) {
  const next = { ...skillSummary.value, [key]: value };
  emit('update:modelValue', withManifest({ ...manifest.value, skillSummary: next }));
}

function onBodyChange(body: string) {
  const files = { ...(props.modelValue?.files ?? {}) };
  files['SKILL.md'] = serialiseSkillMarkdown(metadata.value, skillSummary.value, body);
  emit('update:modelValue', { manifest: props.modelValue.manifest, files });
}

function withManifest(m: Record<string, unknown>): DraftShape {
  // Rebuild SKILL.md with the new frontmatter whenever metadata or
  // summary fields change, so the body-editor view stays coherent.
  const files = { ...(props.modelValue?.files ?? {}) };
  files['SKILL.md'] = serialiseSkillMarkdown((m as any).metadata, (m as any).skillSummary, skillBody.value);

  return { manifest: m, files };
}

function serialiseSkillMarkdown(
  meta: Record<string, unknown>,
  summary: Record<string, unknown>,
  body: string,
): string {
  const lines: string[] = ['---'];
  if (typeof meta?.name === 'string')        lines.push(`name: ${ quote(meta.name) }`);
  if (typeof meta?.description === 'string') lines.push(`description: ${ quote(meta.description) }`);
  if (typeof meta?.version === 'string')     lines.push(`version: ${ meta.version }`);
  if (typeof meta?.category === 'string')    lines.push(`category: ${ meta.category }`);
  if (typeof summary?.skillKey === 'string') lines.push(`skill_key: ${ summary.skillKey }`);
  if (typeof summary?.condition === 'string') lines.push(`condition: ${ summary.condition }`);
  if (Array.isArray(meta?.tags) && (meta.tags as unknown[]).length > 0) {
    lines.push(`tags: [${ (meta.tags as unknown[]).map(t => quote(String(t))).join(', ') }]`);
  }
  lines.push('---', '');
  lines.push(body);

  return lines.join('\n');
}

function quote(s: string): string {
  return JSON.stringify(s);
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
input, textarea {
  font-family: var(--sans);
  font-size: 13px;
  color: white;
  background: rgba(10, 18, 36, 0.6);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 8px 10px;
  outline: none;
}
input:focus, textarea:focus {
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
