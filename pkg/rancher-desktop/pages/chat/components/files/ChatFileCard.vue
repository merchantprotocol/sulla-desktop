<template>
  <article class="file-card">
    <div class="glyph">◇</div><div class="meta"><b>{{ reference.name }}</b><small>{{ provenance }}</small></div>
    <div class="actions"><button type="button" @click="open">Open</button><button type="button" @click="history">History</button><button type="button" @click="link">Link</button></div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ reference:{ fileId:string; versionId?:string; path:string; name:string; createdByType?:string; createdById?:string } }>();
const provenance = computed(() => props.reference.createdByType === 'agent-run' ? `Made by ${ props.reference.createdById || 'Sulla' } · persistent Files version` : 'From Sulla Files · persistent version');
async function open() { await ipcRenderer.invoke('files-ui:open-file', props.reference.path) }
async function history() {
  const versions = await ipcRenderer.invoke('sulla-files:history', { fileId: props.reference.fileId }) as any[];
  window.alert(versions.map((version, index) => `v${ versions.length - index } · ${ new Date(version.created_at).toLocaleString() }`).join('\n') || 'No earlier versions');
}
async function link() {
  const result = await ipcRenderer.invoke('files-ui:create-link', { fileId: props.reference.fileId, mode: 'view', keepAvailable: false }) as { url:string };
  await navigator.clipboard.writeText(result.url);
}
</script>

<style scoped>
.file-card { display:flex; align-items:center; gap:10px; max-width:560px; margin:10px 0; padding:10px; border:1px solid var(--nx-hair-strong); border-radius:10px; background:color-mix(in srgb,var(--nx-surface) 90%,transparent); }
.glyph { width:38px; height:38px; display:grid; place-items:center; border-radius:8px; color:var(--nx-accent-2); background:color-mix(in srgb,var(--nx-accent) 13%,transparent); }.meta{min-width:0;flex:1}.meta b,.meta small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta b{font:600 12px var(--font-mono,monospace)}.meta small{margin-top:3px;color:var(--nx-read-4);font:10px var(--font-mono,monospace)}.actions{display:flex;gap:4px}.actions button{border:1px solid var(--nx-hair-strong);border-radius:6px;padding:4px 7px;background:transparent;color:var(--nx-read-2);font:10px var(--font-mono,monospace)}.actions button:hover{color:var(--nx-accent-2);border-color:var(--nx-accent)}
</style>
