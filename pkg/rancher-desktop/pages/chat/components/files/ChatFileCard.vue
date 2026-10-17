<template>
  <article class="file-card">
    <div class="glyph">◇</div><div class="meta"><b>{{ reference.name }}</b><small>{{ provenance }}</small></div>
    <div class="actions"><button type="button" @click="open">Open</button><button type="button" @click="navigate('versions')">History</button><button type="button" @click="navigate('share-review')">Share</button></div>
  </article>
</template>

<script setup lang="ts">
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { computed } from 'vue';

import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';

const props = defineProps<{ reference:{ fileId:string; versionId?:string; path:string; name:string; createdByType?:string; createdById?:string } }>();
const { createTab, tabs, updateTab } = useBrowserTabs();
const provenance = computed(() => props.reference.createdByType === 'agent-run' ? `Made by ${ props.reference.createdById || 'Sulla' } · persistent Files version` : 'From Sulla Files · persistent version');
async function open() { await ipcRenderer.invoke('files-ui:open-file', { fileId: props.reference.fileId, versionId: props.reference.versionId }) }
function navigate(section:'versions' | 'share-review') {
  const filesNavigation = { fileId: props.reference.fileId, path: props.reference.path, section };
  const existing = tabs.find(tab => tab.mode === 'files');
  const tab = existing ?? createTab('about:blank', { mode: 'files', title: 'Files', filesNavigation });
  if (existing) updateTab(existing.id, { filesNavigation });
  window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } }));
}
</script>

<style scoped>
.file-card { display:flex; align-items:center; gap:10px; max-width:560px; margin:10px 0; padding:10px; border:1px solid var(--nx-hair-strong); border-radius:10px; background:color-mix(in srgb,var(--nx-surface) 90%,transparent); }
.glyph { width:38px; height:38px; display:grid; place-items:center; border-radius:8px; color:var(--nx-accent-2); background:color-mix(in srgb,var(--nx-accent) 13%,transparent); }.meta{min-width:0;flex:1}.meta b,.meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta b{font:600 12px var(--font-mono,monospace)}.meta small{margin-top:3px;color:var(--nx-read-4);font:10px var(--font-mono,monospace)}.actions{display:flex;gap:4px}.actions button{border:1px solid var(--nx-hair-strong);border-radius:6px;padding:4px 7px;background:transparent;color:var(--nx-read-2);font:10px var(--font-mono,monospace)}.actions button:hover{color:var(--nx-accent-2);border-color:var(--nx-accent)}
</style>
