<template>
  <aside class="chat-files">
    <header><span>◇</span><b>Files in this chat</b><button type="button" @click="$emit('open-files')">Open Files</button></header>
    <section v-if="attached.length"><h3>Attached</h3><FileRow v-for="file in attached" :key="file.fileId" :file="file" @open="open" /></section>
    <section v-if="madeHere.length"><h3>Made here</h3><FileRow v-for="file in madeHere" :key="file.fileId" :file="file" @open="open" /></section>
    <section v-if="scratch.length"><h3>Scratch</h3><div v-for="file in scratch" :key="file.fileId" class="row"><span class="icon">◇</span><div><b>{{ file.name }}</b><small>{{ file.agentRunId || file.createdById || 'agent run' }}</small></div><button type="button" @click="keep(file)">Keep</button></div></section>
    <p v-if="!attached.length && !madeHere.length && !scratch.length" class="empty">Files attached to this conversation and files made by its agents show up here.</p>
  </aside>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { useChatController } from '../../controller/useChatController';

interface RefFile { fileId:string; versionId:string; path:string; name:string; mime:string; size:number; collectionId?:string; collectionKind?:string; createdByType?:string; createdById?:string; agentRunId?:string }
defineEmits<(e:'open-files')=>void>();
const controller = useChatController(); const inventory = ref<RefFile[]>([]); let timer:ReturnType<typeof setInterval> | undefined;
const messageRefs = computed(() => controller.messages.value.flatMap(message => message.kind === 'user' ? (message.attachments ?? []).flatMap(item => item.fileRef ? [{ ...item.fileRef, name: item.name }] : []) : message.kind === 'sulla' ? (message.fileReferences ?? []).flatMap(item => item.fileRef ? [{ ...item.fileRef, name: item.name }] : []) : []));
const attached = computed(() => messageRefs.value.filter(file => file.createdByType !== 'agent-run'));
const runIds = computed(() => new Set(messageRefs.value.map(file => file.agentRunId || file.createdById).filter(Boolean)));
const madeHere = computed(() => inventory.value.filter(file => file.collectionKind !== 'scratch' && file.createdByType === 'agent-run' && (!runIds.value.size || runIds.value.has(file.agentRunId || file.createdById))));
const scratch = computed(() => inventory.value.filter(file => file.collectionKind === 'scratch' && (!runIds.value.size || runIds.value.has(file.agentRunId || file.createdById))));
async function refresh() { inventory.value = await ipcRenderer.invoke('files-ui:chat-inventory').catch(() => []) }
async function open(file:RefFile) { await ipcRenderer.invoke('files-ui:open-file', file.path) }
async function keep(file:RefFile) {
  const target = inventory.value.find(item => item.collectionKind === 'knowledge')?.collectionId;
  if (!target) throw new Error('No persistent Files collection is available');
  await ipcRenderer.invoke('sulla-files:keep', { fileId: file.fileId, collectionId: target, path: file.path }); await refresh();
}
const FileRow = defineComponent({ props: { file: { type:Object as () => RefFile, required:true } }, emits:['open'], setup(props,{emit}) { return () => h('div',{class:'row'},[h('span',{class:'icon'},'◇'),h('div',[h('b',props.file.name),h('small',`v${ props.file.versionId.slice(0,6) } · persistent reference`)]),h('button',{type:'button',onClick:()=>emit('open',props.file)},'Open')]) } });
onMounted(() => { void refresh(); timer = setInterval(refresh, 15_000) }); onBeforeUnmount(() => { if (timer) clearInterval(timer) });
</script>

<style scoped>
.chat-files{position:relative;z-index:5;width:280px;min-width:240px;border-left:1px solid var(--nx-hair);background:color-mix(in srgb,var(--nx-surface) 62%,transparent);overflow:auto}.chat-files header{height:48px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--nx-hair)}header span{color:var(--nx-accent-2)}header b{font:600 11px var(--font-mono,monospace)}header button,.row button{margin-left:auto;border:0;background:transparent;color:var(--nx-accent-2);font:10px var(--font-mono,monospace)}section{padding:6px 8px}h3{margin:8px 6px 4px;color:var(--nx-read-4);font:9px var(--font-mono,monospace);letter-spacing:.1em;text-transform:uppercase}.row{display:flex;align-items:center;gap:8px;padding:7px 6px;border-radius:7px}.row:hover{background:color-mix(in srgb,var(--nx-accent) 8%,transparent)}.row .icon{color:var(--nx-accent-2)}.row>div{min-width:0;flex:1}.row b,.row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row b{font:500 11px var(--font-mono,monospace)}.row small{margin-top:2px;color:var(--nx-read-4);font:9px var(--font-mono,monospace)}.empty{padding:18px;color:var(--nx-read-4);font:10px/1.5 var(--font-mono,monospace)}@media(max-width:1180px){.chat-files{display:none}}
</style>
