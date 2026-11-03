<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Artifact header — name + status + actions (Expand / Close). -->
<template>
  <div class="artifact-head">
    <div class="name">
      {{ artifact.name }}
      <small>{{ typeLabel }}</small>
    </div>
    <div class="spacer" />
    <div :class="['status', artifact.status === 'done' ? 'done' : '']">
      {{ artifact.status }}
    </div>
    <span v-if="actionError || artifact.filesRegistrationStatus === 'error'" class="files-error" :title="actionError || artifact.filesRegistrationError || 'Files registration failed'">{{ actionError ? 'Files action failed' : 'Files failed' }}</span>
    <button v-if="artifact.filesRegistrationStatus === 'error'" class="act" type="button" :disabled="retrying" @click="retryFiles">{{ retrying ? 'Retrying' : 'Retry Files' }}</button>
    <button v-if="artifact.filesFileId" class="act" type="button" @click="openFile">Open</button>
    <button v-if="artifact.filesFileId" class="act" type="button" @click="shareFile">Share</button>
    <button class="act" type="button" @click="$emit('expand')">Expand</button>
    <button class="act" type="button" @click="controller.closeArtifact(artifact.id)">Close</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Artifact } from '../../models/Artifact';
import { useChatController } from '../../controller/useChatController';

import { openDocumentTab, useBrowserTabs } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { supportsDocumentEditor } from '@pkg/pages/files/editor/editorTypes';

const props = defineProps<{ artifact: Artifact }>();
defineEmits<{ (e: 'expand'): void }>();
const controller = useChatController();
const { createTab, tabs, updateTab } = useBrowserTabs();
const retrying = ref(false);
const actionError = ref('');
const typeLabel = computed(() => ({ workflow: 'Workflow', html: 'HTML Artifact', code: 'Code File', markdown: 'Markdown' })[props.artifact.kind]);

async function openFile(): Promise<void> {
  if (!props.artifact.filesFileId) return;
  const path = props.artifact.filesPath || props.artifact.name;
  if (supportsDocumentEditor(path)) {
    openDocumentTab({ fileId: props.artifact.filesFileId, path });
    return;
  }
  actionError.value = '';
  try {
    await ipcRenderer.invoke('files-ui:open-file', { fileId: props.artifact.filesFileId, versionId: props.artifact.filesVersionId ?? undefined });
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

function shareFile(): void {
  if (!props.artifact.filesFileId) return;
  const filesNavigation = { fileId: props.artifact.filesFileId, path: props.artifact.filesPath ?? undefined, section: 'share-review' };
  const existing = tabs.find(tab => tab.mode === 'files');
  const tab = existing ?? createTab('about:blank', { mode: 'files', title: 'File Manager', filesNavigation });
  if (existing) updateTab(existing.id, { filesNavigation });
  window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } }));
}

async function retryFiles(): Promise<void> {
  if (!props.artifact.threadId || retrying.value) return;
  retrying.value = true;
  actionError.value = '';
  try {
    await ipcRenderer.invoke('chat-artifacts:retry-files-registration', { threadId: props.artifact.threadId, idOrName: props.artifact.id });
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    retrying.value = false;
  }
}
</script>

<style scoped>
.artifact-head {
  padding: 14px 22px;
  display: flex; align-items: center; gap: 14px;
  border-bottom: 1px solid var(--accent-dim);
  background: var(--accent-glow);
}
.name { font-family: var(--font-display); font-style: italic; font-size: 17px; color: var(--text-on-accent); }
.name small {
  font-family: var(--font-mono); font-size: 10px; font-style: normal;
  letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--text-muted); margin-left: 10px;
}
.spacer { flex: 1; }
.status {
  font-family: var(--font-mono); font-size: 9.5px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--accent-hover);
  display: inline-flex; align-items: center; gap: 8px;
}
.status::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent-hover); box-shadow: 0 0 10px var(--accent-hover);
  animation: chat-pulse 1.5s infinite;
}
.status.done { color: var(--status-success); }
.status.done::before { background: var(--status-success); box-shadow: none; animation: none; }
.act {
  background: transparent; border: 1px solid var(--accent-dim);
  color: var(--text-secondary); padding: 5px 10px; border-radius: 6px;
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.18em;
  text-transform: uppercase; cursor: pointer;
  transition: all 0.15s ease;
}
.act:hover {
  border-color: var(--accent-hover); color: var(--text-secondary);
  background: var(--accent-dim);
}
.act:disabled { cursor: wait; opacity: 0.55; }
.files-error {
  max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--status-error); font: 600 9.5px var(--font-mono); letter-spacing: 0.12em; text-transform: uppercase;
}
</style>
