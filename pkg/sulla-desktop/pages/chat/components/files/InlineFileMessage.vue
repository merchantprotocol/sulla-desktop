<template>
  <InlineFileCard :file="file" @open-in-tab="openInTab" @show-in-files="showInFiles" @download="download">
    <template #preview="{ file: previewFile }">
      <InlineTextPreview
        v-if="textKind"
        :kind="textKind"
        :content="String(previewFile.preview?.kind === 'custom' ? content : '')"
        :file-name="previewFile.name"
        :version-token="versionId"
        :authorized="true"
        :complete="!truncated"
        @save-request="saveMarkdown"
      />
    </template>
  </InlineFileCard>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import InlineFileCard from './InlineFileCard.vue';
import InlineHtmlPreview from './InlineHtmlPreview.vue';
import InlineImagePreview from './InlineImagePreview.vue';
import InlineArchivePreview from './InlineArchivePreview.vue';
import InlineTextPreview from './inline/InlineTextPreview.vue';
import type { InlineFileActionReference, InlineFileCardViewModel } from './inlineFilePreview';

type Reference = { fileId: string; collectionId: string; toolCallId: string; threadId: string };
const props = defineProps<{ reference: Reference }>();
const file = ref<InlineFileCardViewModel>({ fileId: props.reference.fileId, name: 'File', path: '', status: 'loading' });
const content = ref('');
const versionId = ref('');
const truncated = ref(false);
const textKind = ref<'markdown' | 'code' | 'csv' | undefined>();

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value === 'object' && Array.isArray((value as any).data)) return Uint8Array.from((value as any).data);
  return new Uint8Array();
}
function text(value: unknown): string { return typeof value === 'string' ? value : new TextDecoder().decode(bytes(value)); }
async function load(): Promise<void> {
  try {
    const result = await ipcRenderer.invoke('sulla-files:preview-read', { fileId: props.reference.fileId }) as any;
    if (result.state !== 'ready') {
      file.value = { ...file.value, status: result.state === 'unavailable' || result.state === 'deleted' ? 'access-denied' : 'error', message: result.reason || result.state };
      return;
    }
    const doc = result.document;
    content.value = text(result.content); versionId.value = doc.currentVersionId || ''; truncated.value = !!result.truncated;
    file.value = { fileId: doc.id, name: doc.name, path: doc.path, mimeType: doc.mime, sizeLabel: `${doc.size} bytes`, status: 'ready', canOpenInTab: true,
      preview: result.kind === 'html' ? { kind: 'html', source: content.value } : result.kind === 'image' ? { kind: 'image', bytes: bytes(result.content), mimeType: doc.mime, altText: doc.name } : result.kind === 'archive' ? { kind: 'archive', entries: [], totalEntries: 0 } : { kind: 'custom' } };
    textKind.value = ['markdown', 'code', 'csv'].includes(result.kind) ? result.kind : undefined;
  } catch (error) { file.value = { ...file.value, status: 'error', message: error instanceof Error ? error.message : 'Preview unavailable.' }; }
}
function openInTab(reference: InlineFileActionReference): void { ipcRenderer.send('agent-command' as any, { command: 'open-files-item', requestId: crypto.randomUUID(), fileId: reference.fileId, path: reference.path, collectionId: props.reference.collectionId, kind: 'file', mode: 'view', focus: true }); }
function showInFiles(reference: InlineFileActionReference): void { ipcRenderer.send('agent-command' as any, { command: 'open-tab', mode: 'files', fileId: reference.fileId, path: reference.path, collectionId: props.reference.collectionId }); }
async function download(reference: InlineFileActionReference): Promise<void> { await ipcRenderer.invoke('files-ui:download-file', { fileId: reference.fileId, name: reference.name }); }
async function saveMarkdown(request: { content: string; baseVersionId: string }): Promise<void> {
  try { const result = await ipcRenderer.invoke('sulla-files:save-content', { fileId: props.reference.fileId, baseVersionId: request.baseVersionId, content: request.content }) as any; if (result?.versionId) versionId.value = result.versionId; }
  catch (error) { console.warn('[InlineFileMessage] Markdown save failed', error); }
}
onMounted(load);
</script>
