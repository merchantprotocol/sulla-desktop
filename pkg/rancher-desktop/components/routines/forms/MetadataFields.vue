<template>
  <div class="meta-fields">
    <label class="f">
      <span class="l">Name</span>
      <input
        type="text"
        :value="metadata.name"
        @input="patch('name', ($event.target as HTMLInputElement).value)"
      >
    </label>
    <label class="f">
      <span class="l">Version</span>
      <input
        type="text"
        :value="metadata.version"
        placeholder="1.0.0"
        @input="patch('version', ($event.target as HTMLInputElement).value)"
      >
    </label>
    <label class="f span-2">
      <span class="l">Tagline</span>
      <input
        type="text"
        :value="metadata.tagline ?? ''"
        placeholder="Short editorial pitch shown under the title"
        @input="patch('tagline', ($event.target as HTMLInputElement).value)"
      >
    </label>
    <label class="f span-2">
      <span class="l">Description</span>
      <textarea
        :value="metadata.description ?? ''"
        rows="3"
        placeholder="Shown on browse cards and the detail page."
        @input="patch('description', ($event.target as HTMLTextAreaElement).value)"
      />
    </label>
    <label class="f">
      <span class="l">Category</span>
      <input
        type="text"
        :value="metadata.category ?? ''"
        placeholder="e.g. sales, billing, ops"
        @input="patch('category', ($event.target as HTMLInputElement).value)"
      >
    </label>
    <label class="f">
      <span class="l">License</span>
      <input
        type="text"
        :value="metadata.license ?? ''"
        placeholder="MIT, Apache-2.0, Unlicensed…"
        @input="patch('license', ($event.target as HTMLInputElement).value)"
      >
    </label>
    <label class="f span-2">
      <span class="l">Tags (comma-separated, max 20)</span>
      <input
        type="text"
        :value="tagsString"
        placeholder="automation, leads, gmail"
        @input="onTagsInput(($event.target as HTMLInputElement).value)"
      >
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Metadata {
  name?:        string;
  version?:     string;
  tagline?:     string;
  description?: string;
  category?:    string;
  license?:     string;
  tags?:        string[];
  [k: string]:  unknown;
}

const props = defineProps<{
  modelValue: Metadata;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: Metadata): void;
}>();

const metadata = computed(() => props.modelValue ?? {});

const tagsString = computed(() => (Array.isArray(metadata.value.tags) ? metadata.value.tags.join(', ') : ''));

function patch(key: keyof Metadata, value: string) {
  emit('update:modelValue', { ...metadata.value, [key]: value });
}

function onTagsInput(value: string) {
  const tags = value.split(',').map(t => t.trim()).filter(Boolean).slice(0, 20);
  emit('update:modelValue', { ...metadata.value, tags });
}
</script>

<style scoped lang="scss">
.meta-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.f.span-2 { grid-column: 1 / -1; }
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
  transition: border-color 0.15s;
}
input:focus, textarea:focus {
  border-color: var(--steel-300);
}
textarea {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  min-height: 70px;
}
</style>
