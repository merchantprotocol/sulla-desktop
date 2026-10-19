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
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import FileGlyph from './FileGlyph.vue';
import FileStatusIcon from './FileStatusIcon.vue';

import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ reference: { fileId: string; versionId?: string; path: string; name: string; mime?: string; createdByType?: string; createdById?: string } }>();
const { createTab, tabs, updateTab } = useBrowserTabs();
const provenance = computed(() => props.reference.createdByType === 'agent-run' ? `Made by ${ props.reference.createdById || 'Sulla' } · persistent Files version` : 'From Sulla Files · persistent version');
async function open() { await ipcRenderer.invoke('files-ui:open-file', { fileId: props.reference.fileId, versionId: props.reference.versionId }) }
function navigate(section:'versions' | 'share-review') {
  const filesNavigation = { fileId: props.reference.fileId, path: props.reference.path, section };
  const existing = tabs.find(tab => tab.mode === 'files');
  const tab = existing ?? createTab('about:blank', { mode: 'files', title: 'File Manager', filesNavigation });
  if (existing) updateTab(existing.id, { filesNavigation });
  window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } }));
}
</script>

<style scoped>
.file-card { display:flex; align-items:center; gap:10px; max-width:480px; margin:8px 0; padding:10px; border:1px solid var(--nx-hair); border-radius:10px; background:var(--nx-surface); color:var(--nx-read-1); box-sizing:border-box; }
.file-card :deep(.file-glyph){width:40px;height:40px}.file-card :deep(.file-glyph svg){width:21px;height:21px}.meta{min-width:0;flex:1}.meta b,.meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta b{font:600 12.5px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.meta small{margin-top:3px;color:var(--nx-read-4);font:11px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.actions{display:flex;gap:4px;flex:none}.actions button{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--nx-hair-strong);border-radius:6px;padding:3px 7px;background:transparent;color:var(--nx-read-2);font:500 11.5px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.actions button svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}.actions button:hover{color:var(--nx-accent-2);border-color:var(--nx-accent)}
.actions button:focus-visible{outline:2px solid var(--nx-accent);outline-offset:2px}
@media(max-width:480px){.file-card{flex-wrap:wrap}.actions{margin-left:auto}}
</style>
