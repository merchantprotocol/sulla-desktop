<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!-- Artifact header — name + status + actions (Expand / Close). -->
<template>
  <div class="artifact-head">
    <div class="title-block"><small><span :class="['status-dot', artifact.status === 'done' ? 'done' : '']" />{{ artifact.status }} · {{ typeLabel }}</small><h2>{{ artifact.name }}</h2></div>
    <div class="spacer" />
    <span v-if="actionError || artifact.filesRegistrationStatus === 'error'" class="files-error" :title="actionError || artifact.filesRegistrationError || 'Files registration failed'">{{ actionError ? 'Files action failed' : 'Files failed' }}</span>
    <button v-if="artifact.filesRegistrationStatus === 'error'" class="act" type="button" :disabled="retrying" @click="retryFiles">{{ retrying ? 'Retrying' : 'Retry Files' }}</button>
    <button v-if="artifact.filesFileId" class="act" type="button" title="Open in editor" aria-label="Open in editor" @click="openFile">↗</button>
    <button v-if="artifact.filesFileId" class="act" type="button" title="Share" aria-label="Share" @click="shareFile">⇧</button>
    <button class="act" type="button" title="Expand" aria-label="Expand" @click="$emit('expand')">⛶</button>
    <button class="act" type="button" title="Close artifact" aria-label="Close artifact" @click="controller.closeArtifact(artifact.id)">×</button>
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
  padding: 16px 20px 14px;
  display: flex; align-items: center; gap: 14px;
  border-bottom: 1px solid rgba(168, 192, 220, 0.1);
  background: transparent;
}
.title-block{min-width:0}.title-block small{display:flex;align-items:center;gap:6px;color:var(--text-muted);font:11px var(--mono);letter-spacing:.06em;text-transform:uppercase}.title-block h2{margin:6px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary);font:italic 500 22px/1.15 var(--serif);letter-spacing:-.01em}.status-dot{width:6px;height:6px;border-radius:50%;background:var(--accent-primary);animation:chat-pulse 1.5s infinite}.status-dot.done{background:var(--text-success);animation:none}
.spacer { flex: 1; }
.status {
  font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.22em;
  text-transform: uppercase; color: var(--steel-400);
  display: inline-flex; align-items: center; gap: 8px;
}
.status::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: var(--steel-400); box-shadow: 0 0 10px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}
.status.done { color: var(--ok); }
.status.done::before { background: var(--ok); box-shadow: none; animation: none; }
.act {
  width:32px;height:32px;background:transparent;border:0;color:var(--text-secondary);padding:0;border-radius:8px;font-size:16px;cursor:pointer;
  transition: all 0.15s ease;
}
.act:hover {
  color:var(--text-primary);background:var(--bg-surface-alt);
}
.act:disabled { cursor: wait; opacity: 0.55; }
.files-error {
  max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--danger, #e36b65); font: 600 9.5px var(--mono); letter-spacing: 0.12em; text-transform: uppercase;
}
</style>
