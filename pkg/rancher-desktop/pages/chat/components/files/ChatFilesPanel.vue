<template>
  <aside class="chat-files">
    <header>
      <span>◇</span><b>Files in this chat</b><button
        type="button"
        @click="$emit('open-files')"
      >
        Open Files
      </button>
    </header>
    <section v-if="attached.length">
      <h3>Attached</h3><FileRow
        v-for="item in attached"
        :key="item.fileId"
        :file="item"
        @open="open"
      />
    </section>
    <section v-if="madeHere.length">
      <h3>Made here</h3><FileRow
        v-for="item in madeHere"
        :key="item.fileId"
        :file="item"
        @open="open"
      />
    </section>
    <section v-if="scratch.length">
      <h3>Scratch</h3><div
        v-for="item in scratch"
        :key="item.fileId"
        class="row"
      >
        <span class="icon">◇</span><div><b>{{ item.name }}</b><small>{{ item.agentRunId || item.createdById || 'agent run' }}</small></div><button
          type="button"
          @click="keep(item)"
        >
          Keep
        </button>
      </div>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p
      v-if="!attached.length && !madeHere.length && !scratch.length"
      class="empty"
    >
      Files attached to this conversation and files made by its agents show up here.
    </p>
  </aside>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue';

import { useChatController } from '../../controller/useChatController';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface RefFile { fileId: string; versionId: string; path: string; name: string; mime: string; size: number; collectionId?: string; collectionKind?: string; createdByType?: string; createdById?: string; agentRunId?: string }
defineEmits<(e:'open-files')=>void>();
const controller = useChatController(); const inventory = ref<RefFile[]>([]); const error = ref(''); let timer:ReturnType<typeof setInterval> | undefined;
const messageRefs = computed(() => controller.messages.value.flatMap(message => message.kind === 'user' ? (message.attachments ?? []).flatMap(item => item.fileRef ? [{ ...item.fileRef, name: item.name }] : []) : message.kind === 'sulla' ? (message.fileReferences ?? []).flatMap(item => item.fileRef ? [{ ...item.fileRef, name: item.name }] : []) : []));
const stagedRefs = computed(() => controller.staged.value.flatMap(item => item.fileRef ? [{ ...item.fileRef, name: item.name }] : []));
const attached = computed(() => [...stagedRefs.value, ...messageRefs.value].filter((file, index, values) => values.findIndex(other => other.fileId === file.fileId && other.versionId === file.versionId) === index));
const runIds = computed(() => new Set([
  controller.thread.value.id,
  controller.thread.value.backendThreadId,
  ...controller.messages.value.flatMap(message => message.kind === 'subagent_exchange' ? [message.jobId, message.conversationId] : []),
  ...messageRefs.value.filter(file => file.createdByType === 'agent-run').map(file => file.agentRunId || file.createdById),
].filter((value): value is string => Boolean(value))));
const madeHere = computed(() => inventory.value.filter(file => file.collectionKind !== 'scratch' && file.createdByType === 'agent-run' && runIds.value.has(file.agentRunId || file.createdById || '')));
const scratch = computed(() => inventory.value.filter(file => file.collectionKind === 'scratch' && runIds.value.has(file.agentRunId || file.createdById || '')));
async function refresh() {
  try {
    inventory.value = await ipcRenderer.invoke('files-ui:chat-inventory', { runIds: [...runIds.value], threadId: controller.thread.value.backendThreadId || controller.thread.value.id });
    error.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function open(file:RefFile) {
  try { await ipcRenderer.invoke('files-ui:open-file', { fileId: file.fileId, versionId: file.versionId }); error.value = ''; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
async function keep(file:RefFile) {
  const collections = await ipcRenderer.invoke('sulla-files:collections') as { id: string; kind: string }[];
  const target = collections.find(item => item.kind === 'knowledge')?.id;
  if (!target) throw new Error('No persistent Files collection is available');
  await ipcRenderer.invoke('sulla-files:keep', { fileId: file.fileId, collectionId: target, path: file.path }); await refresh();
}
const FileRow = defineComponent({ props: { file: { type: Object as () => RefFile, required: true } }, emits: ['open'], setup(props, { emit }) { return () => h('div', { class: 'row' }, [h('span', { class: 'icon' }, '◇'), h('div', [h('b', props.file.name), h('small', `v${ props.file.versionId.slice(0, 6) } · persistent reference`)]), h('button', { type: 'button', onClick: () => emit('open', props.file) }, 'Open')]) } });
onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 15_000) }); onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.chat-files{position:relative;z-index:5;width:280px;min-width:240px;border-left:1px solid var(--nx-hair);background:color-mix(in srgb,var(--nx-surface) 62%,transparent);overflow:auto}.chat-files header{height:48px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--nx-hair)}header span{color:var(--nx-accent-2)}header b{font:600 11px var(--font-mono,monospace)}header button,.row button{margin-left:auto;border:0;background:transparent;color:var(--nx-accent-2);font:10px var(--font-mono,monospace)}section{padding:6px 8px}h3{margin:8px 6px 4px;color:var(--nx-read-4);font:9px var(--font-mono,monospace);letter-spacing:.1em;text-transform:uppercase}.row{display:flex;align-items:center;gap:8px;padding:7px 6px;border-radius:7px}.row:hover{background:color-mix(in srgb,var(--nx-accent) 8%,transparent)}.row .icon{color:var(--nx-accent-2)}.row>div{min-width:0;flex:1}.row b,.row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row b{font:500 11px var(--font-mono,monospace)}.row small{margin-top:2px;color:var(--nx-read-4);font:9px var(--font-mono,monospace)}.empty,.error{padding:18px;color:var(--nx-read-4);font:10px/1.5 var(--font-mono,monospace)}.error{color:var(--nx-danger,#d66)}@media(max-width:1180px){.chat-files{display:none}}
</style>
