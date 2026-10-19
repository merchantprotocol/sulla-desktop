<template>
  <aside
    v-if="open"
    class="chat-files-drawer"
    aria-label="Files in this chat"
  >
    <header>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      ><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
      <b>Files in this chat</b>
      <button
        class="open-files"
        type="button"
        @click="$emit('open-files')"
      >
        Open Files
      </button>
      <button
        class="close"
        type="button"
        aria-label="Close files drawer"
        @click="$emit('close')"
      >
        ×
      </button>
    </header>

    <div class="drawer-scroll">
      <section v-if="attached.length">
        <h3>Attached</h3>
        <button
          v-for="file in attached"
          :key="`${file.fileId}:${file.versionId}`"
          class="file-row row-main"
          type="button"
          @click="openFile(file)"
        >
          <FileGlyph
            :name="file.name"
            :mime="file.mime"
          />
          <span class="file-meta"><b>{{ file.name }}</b><small>{{ file.subtitle }}</small></span>
          <FileStatusIcon />
        </button>
      </section>

      <section v-if="madeHere.length">
        <h3>Made here</h3>
        <button
          v-for="file in madeHere"
          :key="`${file.fileId}:${file.versionId}`"
          class="file-row row-main"
          type="button"
          @click="openFile(file)"
        >
          <FileGlyph
            :name="file.name"
            :mime="file.mime"
          />
          <span class="file-meta"><b>{{ file.name }}</b><small>{{ file.subtitle }}</small></span>
          <FileStatusIcon />
        </button>
      </section>

      <section v-if="scratch.length">
        <h3>Scratch</h3>
        <div
          v-for="file in scratch"
          :key="`${file.fileId}:${file.versionId}`"
          class="file-row"
        >
          <button
            class="row-main"
            type="button"
            @click="openFile(file)"
          >
            <FileGlyph
              :name="file.name"
              :mime="file.mime"
              :folder="file.mime === 'inode/directory'"
            />
            <span class="file-meta"><b>{{ file.name }}</b><small>{{ file.subtitle }}</small></span>
          </button>
          <button
            class="keep"
            type="button"
            @click="keep(file)"
          >
            Keep
          </button>
        </div>
      </section>

      <p
        v-if="error"
        class="error"
        role="alert"
      >
        {{ error }}
      </p>
      <p
        v-else-if="!attached.length && !madeHere.length && !scratch.length"
        class="empty"
      >
        No files in this chat yet.
      </p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import FileGlyph from './FileGlyph.vue';
import FileStatusIcon from './FileStatusIcon.vue';
import { useChatController } from '../../controller/useChatController';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface RefFile {
  fileId:          string;
  versionId?:      string;
  path:            string;
  name:            string;
  mime:            string;
  size:            number;
  updatedAt?:      string;
  collectionId?:   string;
  collectionKind?: string;
  createdByType?:  string;
  createdById?:    string;
  agentRunId?:     string;
}
interface DrawerFile extends RefFile { subtitle: string }
interface AttachmentReference {
  fileId:          string;
  versionId?:      string;
  path:            string;
  mime:            string;
  size:            number;
  updatedAt?:      string;
  collectionId?:   string;
  collectionKind?: string;
  createdByType?:  string;
  createdById?:    string;
  agentRunId?:     string;
}

const props = defineProps<{ open: boolean }>();
defineEmits<{ (e:'close'):void; (e:'open-files'):void }>();

const controller = useChatController();
const inventory = ref<RefFile[]>([]);
const error = ref('');
let timer:ReturnType<typeof setInterval> | undefined;

function timeLabel(timestamp:number):string {
  const value = new Date(timestamp);
  return `${ value.getHours() % 12 || 12 }:${ String(value.getMinutes()).padStart(2, '0') } ${ value.getHours() >= 12 ? 'PM' : 'AM' }`;
}

function fromAttachment(item:{ name: string; fileRef?: AttachmentReference }, subtitle:string):DrawerFile | undefined {
  if (!item.fileRef) return undefined;
  return { ...item.fileRef, name: item.name, updatedAt: item.fileRef.updatedAt, subtitle };
}

function unique(files:DrawerFile[]):DrawerFile[] {
  return files.filter((file, index) => files.findIndex(other => other.fileId === file.fileId && other.versionId === file.versionId) === index);
}

const staged = computed(() => controller.staged.value.flatMap(item => {
  const file = fromAttachment(item, 'Draft · not sent');
  return file ? [file] : [];
}));
const userFiles = computed(() => controller.messages.value.flatMap(message => message.kind === 'user'
  ? (message.attachments ?? []).flatMap(item => {
    const file = fromAttachment(item, `You · ${ timeLabel(message.createdAt) }`);
    return file ? [file] : [];
  })
  : []));
const assistantFiles = computed(() => controller.messages.value.flatMap(message => message.kind === 'sulla'
  ? (message.fileReferences ?? []).flatMap(item => {
    const file = fromAttachment(item, `Sulla · ${ item.fileRef?.versionId ? `v${ item.fileRef.versionId.slice(0, 6) } · ` : '' }${ timeLabel(message.createdAt) }`);
    return file ? [file] : [];
  })
  : []));

const attached = computed(() => unique([...staged.value, ...userFiles.value]));
const runIds = computed(() => new Set([
  controller.thread.value.id,
  controller.thread.value.backendThreadId,
  ...controller.messages.value.flatMap(message => message.kind === 'subagent_exchange' ? [message.jobId, message.conversationId] : []),
  ...assistantFiles.value.map(file => file.agentRunId || file.createdById),
].filter((value):value is string => Boolean(value))));
const inventoryMadeHere = computed(() => inventory.value.filter(file => file.collectionKind !== 'scratch' && file.createdByType === 'agent-run' && runIds.value.has(file.agentRunId || file.createdById || ''))
  .map(file => ({ ...file, subtitle: `Sulla${ file.versionId ? ` · v${ file.versionId.slice(0, 6) }` : '' }` })));
const madeHere = computed(() => {
  const attachedIds = new Set(attached.value.map(file => `${ file.fileId }:${ file.versionId }`));
  return unique([...assistantFiles.value, ...inventoryMadeHere.value]).filter(file => !attachedIds.has(`${ file.fileId }:${ file.versionId }`));
});
const scratch = computed(() => inventory.value.filter(file => file.collectionKind === 'scratch' && runIds.value.has(file.agentRunId || file.createdById || ''))
  .map(file => ({ ...file, subtitle: 'Agent run scratch' })));

async function refresh():Promise<void> {
  if (!props.open) return;
  try {
    inventory.value = await ipcRenderer.invoke('files-ui:chat-inventory', {
      runIds: [...runIds.value], threadId: controller.thread.value.backendThreadId || controller.thread.value.id,
    }) as RefFile[];
    error.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Files in this chat are temporarily unavailable.';
  }
}

async function openFile(file:RefFile):Promise<void> {
  try {
    await ipcRenderer.invoke('files-ui:open-file', { fileId: file.fileId, versionId: file.versionId });
    error.value = '';
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'This file could not be opened.';
  }
}

async function keep(file:RefFile):Promise<void> {
  try {
    const collections = await ipcRenderer.invoke('sulla-files:collections') as { id: string; kind: string }[];
    const target = collections.find(item => item.kind === 'knowledge')?.id;
    if (!target) throw new Error('No persistent Files collection is available.');
    await ipcRenderer.invoke('sulla-files:keep', { fileId: file.fileId, collectionId: target, path: file.path });
    await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'This scratch file could not be kept.';
  }
}

watch([() => props.open, () => controller.thread.value.id, () => [...runIds.value].join('|')], () => refresh(), { immediate: true });
onMounted(() => { timer = setInterval(() => refresh(), 15_000) });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });
</script>

<style scoped>
.chat-files-drawer { position:absolute;inset:0 0 0 auto;z-index:8;width:300px;display:flex;flex-direction:column;border-left:1px solid var(--nx-hair);background:color-mix(in srgb,var(--nx-surface) 86%,transparent);backdrop-filter:blur(18px);color:var(--nx-read-1) }
header { height:48px;display:flex;align-items:center;gap:8px;padding:0 10px 0 14px;border-bottom:1px solid var(--nx-hair);flex:none }
header>svg { width:14px;height:14px;color:var(--nx-read-3) }
header b { font:600 12.5px var(--font-body,var(--sans)) }
header button { border:0;background:transparent }
.open-files { margin-left:auto;color:var(--nx-accent-2);font:500 11.5px var(--font-body,var(--sans)) }
.close { width:25px;height:25px;border-radius:6px;color:var(--nx-read-4);font-size:18px;line-height:1 }
.close:hover { background:color-mix(in srgb,var(--nx-accent) 10%,transparent);color:var(--nx-read-1) }
.drawer-scroll { min-height:0;overflow:auto;padding:8px }
section { margin-bottom:4px }
h3 { margin:8px 6px 4px;color:var(--nx-read-4);font:600 10.5px var(--font-body,var(--sans));letter-spacing:.08em;text-transform:uppercase }
.file-row { width:100%;display:flex;align-items:center;gap:9px;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:var(--nx-read-1);text-align:left }
.file-row:hover { background:color-mix(in srgb,var(--nx-accent) 8%,transparent) }
.row-main { min-width:0;flex:1 }
.file-row :deep(.file-glyph) { width:24px;height:24px;border-radius:6px }
.file-row :deep(.file-glyph svg) { width:13px;height:13px }
.file-meta { min-width:0;flex:1 }
.file-meta b,.file-meta small { display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
.file-meta b { font:500 12px var(--font-body,var(--sans)) }
.file-meta small { margin-top:1px;color:var(--nx-read-4);font:10.5px var(--font-body,var(--sans)) }
.keep { flex:none;border:1px solid var(--nx-hair-strong);border-radius:6px;padding:3px 8px;background:transparent;color:var(--nx-read-2);font:500 11px var(--font-body,var(--sans)) }
.keep:hover { border-color:var(--nx-accent);color:var(--nx-accent-2) }
.empty,.error { margin:12px 8px;padding:14px;border:1px dashed var(--nx-hair-strong);border-radius:9px;color:var(--nx-read-4);font:11px/1.5 var(--font-body,var(--sans));text-align:center }
.error { color:var(--err) }
</style>
