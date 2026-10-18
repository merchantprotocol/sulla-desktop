<template>
  <article class="file-card">
    <div class="glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l5 5v13H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg></div><div class="meta"><b>{{ reference.name }}</b><small>{{ provenance }}</small></div>
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
.file-card { display:flex; align-items:center; gap:10px; max-width:480px; margin:8px 0; padding:10px; border:1px solid var(--nx-hair); border-radius:10px; background:var(--nx-surface); color:var(--nx-read-1); box-sizing:border-box; }
.glyph { width:40px; height:40px; flex:none; display:grid; place-items:center; border-radius:8px; color:var(--nx-accent-2); background:color-mix(in srgb,var(--nx-accent) 13%,transparent); }.glyph svg{width:22px;height:22px}.meta{min-width:0;flex:1}.meta b,.meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta b{font:600 12.5px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.meta small{margin-top:3px;color:var(--nx-read-4);font:11px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.actions{display:flex;gap:4px;flex:none}.actions button{border:1px solid var(--nx-hair-strong);border-radius:6px;padding:3px 7px;background:transparent;color:var(--nx-read-2);font:500 11.5px -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif}.actions button:hover{color:var(--nx-accent-2);border-color:var(--nx-accent)}
.actions button:focus-visible{outline:2px solid var(--nx-accent);outline-offset:2px}
@media(max-width:480px){.file-card{flex-wrap:wrap}.actions{margin-left:auto}}
</style>
