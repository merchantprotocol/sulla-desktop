<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<template>
  <article class="file-card" @contextmenu.stop.prevent="openMenu?.show($event, reference)" @click="navigate('detail')">
    <button class="file-card-open" type="button" :aria-label="`Open ${reference.name} in File Manager`" @click.stop="navigate('detail')"
      @keydown.enter.prevent="!$event.repeat && navigate('detail')"
      @keydown.space.prevent
      @keyup.space.prevent="navigate('detail')"
    >
      <FileGlyph :name="reference.name" :mime="reference.mime" />
      <span class="meta"><b :title="reference.name">{{ reference.name }}</b><small :title="provenance">{{ provenance }}</small></span>
      <FileStatusIcon />
    </button>
    <div class="actions">
      <button type="button" @click.stop="navigate('detail')">
        <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5" /></svg><span>Open</span>
      </button><button
        v-if="supportsDocumentEditor(reference.path)"
        type="button"
        @click.stop="openEditor"
      ><svg viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16v4z" /></svg><span>Open editor</span>
      </button><button
        v-if="editable"
        type="button"
        @click.stop="toggleEditor"
      ><svg viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16v4zM13.5 6.5l4 4" /></svg><span>Edit inline</span>
      </button><button
        type="button"
        @click.stop="navigate('versions')"
      >
        <svg viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5" /><path d="M3.5 3.5v5h5M12 7.5V12l3 2" /></svg><span>History</span>
      </button><button
        type="button"
        @click.stop="navigate('share-review')"
      >
        <svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" /></svg><span>{{ reference.versionId ? 'Link latest' : 'Link' }}</span>
      </button>
    </div>
    <span v-if="navigationError" class="navigation-error" role="alert" @click.stop>{{ navigationError }}</span>
    <div v-if="editing" class="inline-editor" @click.stop>
      <textarea v-model="draft" :disabled="saving" aria-label="Edit project file markdown" />
      <div><span v-if="error" role="alert">{{ error }}</span><button type="button" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save new version' }}</button><button type="button" @click="editing = false">Cancel</button></div>
    </div>
    <ChatFileOpenMenu ref="openMenu" @error="navigationError = $event" />
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import ChatFileOpenMenu from './ChatFileOpenMenu.vue';
import FileGlyph from './FileGlyph.vue';
import FileStatusIcon from './FileStatusIcon.vue';

import { useChatController } from '../../controller/useChatController';
import { openWorkspaceTab } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { supportsDocumentEditor } from '@pkg/pages/files/editor/editorTypes';

const props = defineProps<{ reference: { fileId: string; versionId?: string; path: string; name: string; mime?: string; createdByType?: string; createdById?: string } }>();
import { DURABLE_FILE_ID_PATTERN } from '@pkg/shared/filesReferences';
import type { WorkspaceFilesSection } from '@pkg/shared/workspaceTabRequest';

const openMenu = ref<InstanceType<typeof ChatFileOpenMenu>>();
const navigationError = ref('');
const controller = useChatController();
const editing = ref(false); const saving = ref(false); const draft = ref(''); const artifactId = ref(''); const artifactVersion = ref(0); const error = ref('');
const editable = computed(() => /(?:markdown|text\/plain)/i.test(props.reference.mime || '') || /\.md$/i.test(props.reference.path));
async function toggleEditor() {
  if (editing.value) { editing.value = false; return; }
  error.value = '';
  const result = await ipcRenderer.invoke('chat-artifacts:open-file', { threadId: controller.thread.value.id, fileId: props.reference.fileId });
  artifactId.value = result.artifact.id; artifactVersion.value = result.artifact.version; draft.value = result.artifact.content; editing.value = true;
}
async function save() {
  saving.value = true; error.value = '';
  try {
    const artifact = await ipcRenderer.invoke('chat-artifacts:save', { threadId: controller.thread.value.id, idOrName: artifactId.value, content: draft.value, expectedVersion: artifactVersion.value });
    artifactVersion.value = artifact.version;
    if (artifact.filesRegistrationStatus === 'error') error.value = artifact.filesRegistrationError || 'The Files version changed. Reload before saving again.';
    else editing.value = false;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { saving.value = false; }
}
const provenance = computed(() => props.reference.createdByType === 'agent-run' ? `Made by ${ props.reference.createdById || 'Sulla' } · persistent Files version` : 'From Sulla Files · persistent version');
async function openEditor() {
  navigationError.value = '';
  try {
    await openWorkspaceTab({ mode: 'paper', documentFile: { fileId: props.reference.fileId, path: props.reference.path } });
  } catch {
    navigationError.value = 'Couldn’t open the editor. Try opening the file in Files instead.';
  }
}

async function navigate(section: WorkspaceFilesSection) {
  navigationError.value = '';
  const { fileId, versionId, path } = props.reference;
  if (!DURABLE_FILE_ID_PATTERN.test(fileId) || (versionId && !DURABLE_FILE_ID_PATTERN.test(versionId))) {
    navigationError.value = 'This Files reference is invalid. Ask for a fresh reference.';
    return;
  }
  try {
    await openWorkspaceTab({
      mode: 'files', title: 'File Manager',
      filesNavigation: { fileId, path: path || fileId, section, ...(versionId ? { versionId } : {}) },
    });
  } catch {
    navigationError.value = 'Couldn’t open File Manager. Try again or open Files directly.';
  }
}
</script>

<style scoped>
.file-card { display:flex; flex-wrap:wrap; align-items:center; gap:10px; max-width:480px; margin:8px 0; padding:10px; border:1px solid var(--border-subtle); border-radius:10px; background:var(--bg-surface); color:var(--text-primary); box-sizing:border-box; }
.file-card :deep(.file-glyph){width:40px;height:40px}.file-card :deep(.file-glyph svg){width:21px;height:21px}.meta{min-width:0;flex:1}.meta b,.meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta b{font:600 12.5px var(--font-body)}.meta small{margin-top:3px;color:var(--text-dim);font:11px var(--font-body)}.actions{display:flex;flex-wrap:wrap;gap:4px;flex:0 1 auto;max-width:100%}.actions button{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border-default);border-radius:6px;padding:3px 7px;background:transparent;color:var(--text-secondary);font:500 11.5px var(--font-body)}.actions button svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.actions button:hover{color:var(--primary-color-text-override, var(--accent-hover));border-color:var(--accent)}
/* The open button holds the glyph (40px), status icon (18px) and two 10px gaps; the rest keeps the name at least 9.5rem before the actions wrap. */
.file-card-open{display:flex;align-items:center;gap:10px;flex:1 1 calc(9.5rem + 78px);min-width:0;text-align:left;padding:0;border:0;background:none;color:inherit}.navigation-error{flex-basis:100%;color:var(--status-error);font-size:11px}
.file-card-open:focus-visible,.actions button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.inline-editor{flex:0 0 100%;display:grid;gap:7px}.inline-editor textarea{width:100%;min-height:220px;box-sizing:border-box;padding:10px;border:1px solid var(--border-default);border-radius:7px;background:var(--bg-page);color:var(--text-primary);font:12px/1.55 var(--font-mono)}.inline-editor>div{display:flex;justify-content:flex-end;align-items:center;gap:7px}.inline-editor>div span{margin-right:auto;color:var(--status-error);font-size:11px}
@media(max-width:480px){.file-card{flex-wrap:wrap}.actions{margin-left:auto}}
</style>
