<template>
  <article class="file-card">
    <FileGlyph
      :name="reference.name"
      :mime="reference.mime"
    />
    <div class="meta">
      <b>{{ reference.name }}</b><small>{{ provenance }}</small>
    </div>
    <FileStatusIcon />
    <div class="actions">
      <button
        type="button"
        @click="open"
      >
        <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5" /></svg><span>Open</span>
      </button><button
        v-if="editable"
        type="button"
        @click="toggleEditor"
      ><svg viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16v4zM13.5 6.5l4 4" /></svg><span>Edit inline</span>
      </button><button
        type="button"
        @click="navigate('versions')"
      >
        <svg viewBox="0 0 24 24"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5" /><path d="M3.5 3.5v5h5M12 7.5V12l3 2" /></svg><span>History</span>
      </button><button
        type="button"
        @click="navigate('share-review')"
      >
        <svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" /></svg><span>Link</span>
      </button>
    </div>
    <div v-if="editing" class="inline-editor">
      <textarea v-model="draft" :disabled="saving" aria-label="Edit project file markdown" />
      <div><span v-if="error" role="alert">{{ error }}</span><button type="button" :disabled="saving" @click="save">{{ saving ? 'Saving…' : 'Save new version' }}</button><button type="button" @click="editing = false">Cancel</button></div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import FileGlyph from './FileGlyph.vue';
import FileStatusIcon from './FileStatusIcon.vue';

import { useChatController } from '../../controller/useChatController';
import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { supportsDocumentEditor } from '@pkg/pages/files/editor/editorTypes';

const props = defineProps<{ reference: { fileId: string; versionId?: string; path: string; name: string; mime?: string; createdByType?: string; createdById?: string } }>();
const { createTab, tabs, updateTab } = useBrowserTabs();
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
async function open() {
  if (supportsDocumentEditor(props.reference.path)) {
    const filesNavigation = { fileId: props.reference.fileId, path: props.reference.path, openEditor: true };
    const existing = tabs.find(tab => tab.mode === 'files');
    const tab = existing ?? createTab('about:blank', { mode: 'files', title: 'File Manager', filesNavigation });
    if (existing) updateTab(existing.id, { filesNavigation });
    window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } }));
    return;
  }
  await ipcRenderer.invoke('files-ui:open-file', { fileId: props.reference.fileId, versionId: props.reference.versionId });
}
function navigate(section:'versions' | 'share-review') {
  const filesNavigation = { fileId: props.reference.fileId, path: props.reference.path, section };
  const existing = tabs.find(tab => tab.mode === 'files');
  const tab = existing ?? createTab('about:blank', { mode: 'files', title: 'File Manager', filesNavigation });
  if (existing) updateTab(existing.id, { filesNavigation });
  window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } }));
}
</script>

<style scoped>
.file-card { display:flex; flex-wrap:wrap; align-items:center; gap:10px; max-width:480px; margin:8px 0; padding:10px; border:1px solid var(--nx-hair); border-radius:10px; background:var(--nx-surface); color:var(--nx-read-1); box-sizing:border-box; }
.file-card :deep(.file-glyph){width:40px;height:40px}.file-card :deep(.file-glyph svg){width:21px;height:21px}.meta{min-width:0;flex:1}.meta b,.meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta b{font:600 12.5px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.meta small{margin-top:3px;color:var(--nx-read-4);font:11px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.actions{display:flex;gap:4px;flex:none}.actions button{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--nx-hair-strong);border-radius:6px;padding:3px 7px;background:transparent;color:var(--nx-read-2);font:500 11.5px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.actions button svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.actions button:hover{color:var(--nx-accent-2);border-color:var(--nx-accent)}
.actions button:focus-visible{outline:2px solid var(--nx-accent);outline-offset:2px}
.inline-editor{flex:0 0 100%;display:grid;gap:7px}.inline-editor textarea{width:100%;min-height:220px;box-sizing:border-box;padding:10px;border:1px solid var(--nx-hair-strong);border-radius:7px;background:var(--nx-bg);color:var(--nx-read-1);font:12px/1.55 var(--font-mono)}.inline-editor>div{display:flex;justify-content:flex-end;align-items:center;gap:7px}.inline-editor>div span{margin-right:auto;color:var(--danger);font-size:11px}
@media(max-width:480px){.file-card{flex-wrap:wrap}.actions{margin-left:auto}}
</style>
