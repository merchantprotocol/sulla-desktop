<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
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
        :save-outcome="saveOutcome"
        @save-request="saveMarkdown"
      />
    </template>
  </InlineFileCard>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { openWorkspaceTab } from '@pkg/composables/useBrowserTabs';
import { FilesOpenDestinationRouter } from '@pkg/pages/files/FilesOpenDestinationRouter';
import InlineFileCard from './InlineFileCard.vue';
import InlineTextPreview from './inline/InlineTextPreview.vue';
import { ChatFileOpenAction } from './ChatFileOpenAction';
import type { InlineFileActionReference, InlineFileCardViewModel } from './inlineFilePreview';
import type { FilesSaveSuccess } from '@pkg/pages/files/types';
import type { MarkdownSaveOutcome } from './inline/MarkdownEditSession';

type Reference = { fileId: string; collectionId: string; toolCallId: string; threadId: string };

function formatSize(bytes: unknown): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
const props = defineProps<{ reference: Reference }>();
const openFileAction = new ChatFileOpenAction(new FilesOpenDestinationRouter(), {
  openHtmlInEditor: request => openWorkspaceTab({ mode: 'paper', documentFile: request }),
  openWithDefaultApp: request => ipcRenderer.invoke('files-ui:open-file', request),
});
const file = ref<InlineFileCardViewModel>({ fileId: props.reference.fileId, name: 'File', path: '', status: 'loading' });
const content = ref('');
const versionId = ref('');
const truncated = ref(false);
const textKind = ref<'markdown' | 'code' | 'csv' | undefined>();
const saveOutcome = ref<MarkdownSaveOutcome | null>(null);

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
    const metadataOnly = result.state === 'metadata-only' || result.state === 'too-large' || result.state === 'unsupported';
    if (result.state !== 'ready' && !metadataOnly) {
      file.value = { ...file.value, status: result.state === 'unavailable' || result.state === 'deleted' ? 'access-denied' : 'error', message: result.reason || result.state };
      return;
    }
    const doc = result.document;
    versionId.value = doc.currentVersionId || '';
    if (metadataOnly) {
      content.value = ''; textKind.value = undefined; truncated.value = false;
      file.value = { fileId: doc.id, name: doc.name, path: doc.path, mimeType: doc.mime, sizeLabel: formatSize(doc.size), status: 'ready', canOpenInTab: true };
      return;
    }
    content.value = text(result.content); truncated.value = !!result.truncated;
    file.value = { fileId: doc.id, name: doc.name, path: doc.path, mimeType: doc.mime, sizeLabel: formatSize(doc.size), status: 'ready', canOpenInTab: true,
      preview: result.kind === 'html' ? { kind: 'html', source: content.value } : result.kind === 'image' ? { kind: 'image', bytes: bytes(result.content), mimeType: doc.mime, altText: doc.name } : result.kind === 'pdf' ? undefined : { kind: 'custom' } };
    textKind.value = ['markdown', 'code', 'csv'].includes(result.kind) ? result.kind : undefined;
  } catch (error) { file.value = { ...file.value, status: 'error', message: error instanceof Error ? error.message : 'Preview unavailable.' }; }
}
async function openInTab(reference: InlineFileActionReference): Promise<void> {
  await openFileAction.open({ ...reference, collectionId: props.reference.collectionId, versionId: versionId.value });
}
async function showInFiles(reference: InlineFileActionReference): Promise<void> { await openWorkspaceTab({ mode: 'files', title: 'File Manager', filesNavigation: { fileId: reference.fileId, path: reference.path, section: 'detail', collectionId: props.reference.collectionId, ...(versionId.value ? { versionId: versionId.value } : {}) } }); }
async function download(reference: InlineFileActionReference): Promise<void> { await ipcRenderer.invoke('files-ui:download-file', { fileId: reference.fileId, name: reference.name }); }
async function saveMarkdown(request: { requestId: number; content: string; baseVersionId: string }): Promise<void> {
  try {
    const result = await ipcRenderer.invoke('sulla-files:save-content', {
      fileId: props.reference.fileId, baseVersionId: request.baseVersionId || versionId.value, content: request.content,
    }) as FilesSaveSuccess | { conflict: { error: string; currentVersionId: string } };
    if ('conflict' in result && result.conflict) {
      saveOutcome.value = { requestId: request.requestId, status: 'conflict', message: result.conflict.error, currentVersionToken: result.conflict.currentVersionId };
      return;
    }
    versionId.value = result.versionId;
    saveOutcome.value = { requestId: request.requestId, status: result.status, content: result.content, versionToken: result.versionId };
  } catch (error) {
    const cause = error as any;
    saveOutcome.value = { requestId: request.requestId, status: 'error', message: cause?.message || 'Unable to save this file.' };
  }
}
onMounted(load);
</script>
