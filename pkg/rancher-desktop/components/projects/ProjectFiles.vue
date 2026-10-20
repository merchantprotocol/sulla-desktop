<template>
  <section v-if="files.length || loading" class="project-files">
    <header><b>Files</b><span>{{ files.length }} project document{{ files.length === 1 ? '' : 's' }}</span></header>
    <div v-if="loading" class="empty">Loading files…</div>
    <button v-for="file in files" v-else :key="file.id" type="button" @click="open(file)">
      <span><b>{{ file.name }}</b><small>{{ file.filesPath }}</small></span>
      <span class="lifecycle"><small>Delete when</small>{{ deleteWhen(file.content) }}</span>
      <span aria-hidden="true">↗</span>
    </button>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { restoreChatFromHistory } from '@pkg/pages/chat/services/historyRestore';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { ChatArtifactRecord } from '@pkg/shared/chatArtifacts';

const props = defineProps<{ projectId: string }>();
const router = useRouter();
const files = ref<ChatArtifactRecord[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try { files.value = await ipcRenderer.invoke('work-items:project-files', props.projectId); } finally { loading.value = false; }
}
function deleteWhen(content: string): string {
  const match = content.match(/^delete_when:\s*(.+)$/m);
  if (!match) return 'Not specified';
  try { return JSON.parse(match[1]); } catch { return match[1].replace(/^['"]|['"]$/g, ''); }
}
async function open(file: ChatArtifactRecord) {
  const result = await ipcRenderer.invoke('chat-artifacts:get-by-id', { artifactId: file.id });
  if (!result?.artifact || !result.history) return;
  const tab = restoreChatFromHistory(result.history);
  await router.push(`/Browser/${ tab.id }`);
  await ipcRenderer.invoke(result.artifact.isOpen ? 'chat-artifacts:focus' : 'chat-artifacts:reopen', { threadId: result.threadId, idOrName: result.artifact.id });
}
onMounted(load);
watch(() => props.projectId, load);
</script>

<style scoped>
.project-files{margin:0 18px 14px;padding:12px;border:1px solid var(--border-muted);border-radius:10px;background:var(--surface-1)}
.project-files header{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}.project-files header span,.empty{color:var(--text-muted);font-size:12px}
.project-files button{display:grid;grid-template-columns:minmax(180px,1fr) minmax(220px,2fr) auto;width:100%;gap:16px;align-items:center;padding:9px 10px;border:0;border-top:1px solid var(--border-muted);background:transparent;color:var(--text);text-align:left;cursor:pointer}
.project-files button:hover{background:var(--surface-2)}.project-files button>span{display:grid;gap:2px}.project-files small{color:var(--text-muted);font-size:11px}.lifecycle{font-size:12px}
</style>
