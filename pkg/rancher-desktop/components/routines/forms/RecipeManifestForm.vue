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
      <h4>Extension details</h4>
      <div class="grid-2">
        <label class="f">
          <span class="l">Extension name</span>
          <input
            type="text"
            :value="summary.extension ?? ''"
            placeholder="e.g. twenty-crm"
            @input="onSummary('extension', ($event.target as HTMLInputElement).value)"
          >
        </label>
        <label class="f">
          <span class="l">Version range</span>
          <input
            type="text"
            :value="summary.extensionVersion ?? ''"
            placeholder=">=2.0.0"
            @input="onSummary('extensionVersion', ($event.target as HTMLInputElement).value)"
          >
        </label>
        <label class="f span-2">
          <span class="l">Image reference</span>
          <input
            type="text"
            :value="summary.image ?? ''"
            placeholder="docker.io/owner/image:tag"
            @input="onImage(($event.target as HTMLInputElement).value)"
          >
        </label>
      </div>
      <p class="hint">
        The image is pulled from its own registry at launch time — the marketplace bundle contains only the Compose config, not the image itself.
      </p>
    </section>

    <section class="section">
      <h4>manifest.yaml</h4>
      <p class="hint">
        Catalog descriptor. The Docker extension system reads this to present your recipe in its UI.
      </p>
      <textarea
        class="body-editor"
        :value="files['manifest.yaml'] ?? ''"
        rows="14"
        spellcheck="false"
        @input="onFile('manifest.yaml', ($event.target as HTMLTextAreaElement).value)"
      />
    </section>

    <section class="section">
      <h4>docker-compose.yml</h4>
      <p class="hint">
        Compose file that defines how to run the container. Reference the image by <code>image:</code> key; Docker pulls it on first launch.
      </p>
      <textarea
        class="body-editor"
        :value="files['docker-compose.yml'] ?? ''"
        rows="18"
        spellcheck="false"
        @input="onFile('docker-compose.yml', ($event.target as HTMLTextAreaElement).value)"
      />
    </section>

    <section
      v-if="files['installation.yaml'] !== undefined"
      class="section"
    >
      <h4>installation.yaml</h4>
      <p class="hint">
        Sulla-specific install instructions — ports, volumes, env mappings. Optional; edit only if your recipe needs custom install behavior.
      </p>
      <textarea
        class="body-editor"
        :value="files['installation.yaml'] ?? ''"
        rows="12"
        spellcheck="false"
        @input="onFile('installation.yaml', ($event.target as HTMLTextAreaElement).value)"
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

const manifest = computed(() => props.modelValue?.manifest ?? {});
const metadata = computed(() => (manifest.value as any)?.metadata ?? {});
const summary  = computed(() => (manifest.value as any)?.recipeSummary ?? {});
const files    = computed(() => props.modelValue?.files ?? {});

function onMetadataChange(next: Record<string, unknown>) {
  emit('update:modelValue', {
    manifest: { ...manifest.value, metadata: next },
    files:    files.value,
  });
}

function onSummary(key: string, value: string) {
  emit('update:modelValue', {
    manifest: { ...manifest.value, recipeSummary: { ...summary.value, [key]: value } },
    files:    files.value,
  });
}

function onImage(value: string) {
  // Update the summary and the docker-compose.yml image: key in-place.
  const nextCompose = updateComposeImage(files.value['docker-compose.yml'] ?? '', value);
  emit('update:modelValue', {
    manifest: { ...manifest.value, recipeSummary: { ...summary.value, image: value } },
    files:    { ...files.value, 'docker-compose.yml': nextCompose },
  });
}

function onFile(name: string, value: string) {
  emit('update:modelValue', {
    manifest: manifest.value,
    files:    { ...files.value, [name]: value },
  });
}

function updateComposeImage(compose: string, newImage: string): string {
  // Replace the first `image: ...` line encountered. If none, prepend a
  // minimal services stanza — covers the empty-file case gracefully.
  const lines = compose.split('\n');
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*image\s*:\s*).*$/);
    if (m) {
      lines[i] = `${ m[1] }${ newImage }`;
      replaced = true;
      break;
    }
  }
  if (replaced) return lines.join('\n');
  if (!compose.trim()) {
    return [
      'services:',
      '  main:',
      `    image: ${ newImage }`,
      '',
    ].join('\n');
  }

  return `${ compose }\n# TODO: set image: ${ newImage } on a service\n`;
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
.hint code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--steel-200);
  background: rgba(20, 30, 54, 0.5);
  padding: 1px 5px;
  border-radius: 3px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
.f { display: flex; flex-direction: column; gap: 4px; }
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
}
.body-editor {
  width: 100%;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  resize: vertical;
}
</style>
