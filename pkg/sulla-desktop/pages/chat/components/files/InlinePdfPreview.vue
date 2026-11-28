<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <div class="pdf-preview">
    <p v-if="state.status === 'loading'" class="pdf-status" role="status">Rendering PDF page…</p>
    <p v-else-if="state.status === 'load-error' || state.status === 'render-error'" class="pdf-status pdf-error" role="alert">{{ state.message }}</p>
    <div class="pdf-page-frame">
      <canvas ref="canvas" class="pdf-page" :aria-label="pageDescription" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { InlinePdfPreviewController, type InlinePdfDocumentLoader, type InlinePdfPreviewState } from './inlinePdfPreview';

const props = defineProps<{ bytes: Uint8Array; documentLoader: InlinePdfDocumentLoader }>();
const emit = defineEmits<{ 'state-change': [state: InlinePdfPreviewState] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const state = ref<InlinePdfPreviewState>({ status: 'idle', pageNumber: 1, pageCount: 0 });
const controller = new InlinePdfPreviewController(props.documentLoader);
const pageDescription = ref('PDF page preview');

function publishState(): void {
  state.value = controller.snapshot();
  pageDescription.value = state.value.pageCount > 0
    ? `PDF page ${ state.value.pageNumber } of ${ state.value.pageCount }`
    : 'PDF page preview';
  emit('state-change', state.value);
}

async function load(): Promise<void> {
  const target = canvas.value;
  if (!target) return;
  const pending = controller.open(props.bytes, target);
  publishState();
  await pending;
  publishState();
}

async function previousPage(): Promise<void> {
  const pending = controller.previousPage();
  publishState();
  await pending;
  publishState();
}

async function nextPage(): Promise<void> {
  const pending = controller.nextPage();
  publishState();
  await pending;
  publishState();
}

function handleKey(key: string): boolean {
  const pending = controller.handleKey(key);
  if (!pending) return false;
  publishState();
  void pending.then(publishState);
  return true;
}

watch(() => props.bytes, () => { void load(); });
onMounted(() => { void load(); });
onBeforeUnmount(() => { void controller.destroy(); });

defineExpose({ previousPage, nextPage, handleKey });
</script>

<style scoped>
.pdf-preview { min-width: 0; background: var(--bg-surface-hover, color-mix(in srgb, var(--accent-primary) 5%, var(--bg-surface))); }
.pdf-status { margin: 0; padding: 8px 12px; color: var(--text-muted); font-size: 12px; }
.pdf-error { color: var(--status-error); }
.pdf-page-frame { display: flex; justify-content: center; min-width: 0; max-width: 100%; padding: 12px; overflow: hidden; }
.pdf-page { display: block; width: 100%; max-width: 100%; height: auto; max-height: 75vh; background: #fff; object-fit: contain; box-shadow: 0 0 0 1px var(--border-subtle), 0 1px 2px rgb(20 40 60 / 6%); }
</style>
