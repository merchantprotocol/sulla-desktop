<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <button
    class="chat-attachment"
    type="button"
    :disabled="!attachment.fileRef"
    @click="open"
  >
    <FileGlyph
      :name="attachment.name"
      :mime="attachment.fileRef?.mime"
    />
    <span class="details"><b>{{ attachment.name }}</b><small>{{ subtitle }}</small></span>
    <FileStatusIcon v-if="attachment.fileRef" />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import FileGlyph from './FileGlyph.vue';
import FileStatusIcon from './FileStatusIcon.vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { openDocumentTab } from '@pkg/composables/useBrowserTabs';
import { supportsDocumentEditor } from '@pkg/pages/files/editor/editorTypes';

import type { AttachedFile } from '../../models/Message';

const props = defineProps<{ attachment: AttachedFile }>();
const subtitle = computed(() => {
  const path = props.attachment.fileRef?.path;
  const location = path?.includes('/') ? path.split('/').slice(0, -1).join(' › ') : 'Sulla Files';
  return [location, props.attachment.size].filter(Boolean).join(' · ');
});

async function open():Promise<void> {
  if (!props.attachment.fileRef) return;
  if (supportsDocumentEditor(props.attachment.fileRef.path)) {
    openDocumentTab({ fileId: props.attachment.fileRef.fileId, path: props.attachment.fileRef.path });
    return;
  }
  await ipcRenderer.invoke('files-ui:open-file', { fileId: props.attachment.fileRef.fileId, versionId: props.attachment.fileRef.versionId });
}
</script>

<style scoped>
.chat-attachment { display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:6px 10px 6px 6px;border:1px solid var(--nx-hair);border-radius:9px;background:var(--nx-surface);color:var(--nx-read-1);text-align:left }
.chat-attachment:not(:disabled):hover { border-color:var(--nx-accent);background:color-mix(in srgb,var(--nx-accent) 7%,var(--nx-surface)) }
.chat-attachment:disabled { cursor:default }
.chat-attachment :deep(.file-glyph) { width:24px;height:24px;border-radius:6px }
.chat-attachment :deep(.file-glyph svg) { width:13px;height:13px }
.details { min-width:0;flex:1 }
.details b,.details small { display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.details b { max-width:260px;font:500 12px var(--font-body,var(--sans)) }
.details small { margin-top:1px;color:var(--nx-read-4);font:10.5px var(--font-body,var(--sans)) }
</style>
