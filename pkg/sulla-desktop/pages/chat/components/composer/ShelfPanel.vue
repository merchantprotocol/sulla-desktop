<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  /shelve and /resume, shown above the message box.
  Shelve: confirm exactly what stops, stop it, have Sulla write the handoff
  note, save it to Projects/Shelf, archive the conversation, close the tab.
  Resume: pick a shelved note and open a fresh thread on it, reopen the
  original thread, or delete the note (optionally the conversation too).
-->
<template>
  <section
    class="sp"
    :aria-label="request.mode === 'shelve' ? 'Shelve this thread' : 'Shelved threads'"
  >
    <header class="sp-head">
      <b>{{ request.mode === 'shelve' ? 'Shelve this thread' : 'Shelved threads' }}</b>
      <span class="sp-gap" />
      <button
        type="button"
        class="sp-btn"
        :disabled="busy"
        @click="emit('close')"
      >
        {{ step === 'done' ? 'Close' : 'Cancel' }}
      </button>
    </header>

    <!-- ── Shelve ───────────────────────────────────────────── -->
    <template v-if="request.mode === 'shelve'">
      <div
        v-if="step === 'confirm'"
        class="sp-body"
      >
        <p
          v-if="controller.isRunning.value"
          class="sp-warn"
          role="alert"
        >
          Sulla is mid-reply. Wait for it to finish, or stop it, then shelve.
        </p>
        <label class="sp-field">
          <span>Name</span>
          <input
            v-model="name"
            maxlength="80"
            placeholder="e.g. RC billing"
          >
        </label>
        <p class="sp-label">
          Shelving will:
        </p>
        <ul class="sp-list">
          <li
            v-for="row in liveRows"
            :key="row.key"
          >
            Ask <b>{{ row.label }}</b> to save its work and report, then stop it (stopped anyway after 2 minutes)
          </li>
          <li v-if="heartbeatOn">
            Turn off the heartbeat (every {{ controller.heartbeat.value.intervalMinutes }} min)
          </li>
          <li>Have Sulla write a handoff note to <code>Projects/Shelf/{{ previewSlug }}.md</code></li>
          <li>Move this conversation to Archived in History and close the tab</li>
        </ul>
        <div class="sp-actions">
          <button
            type="button"
            class="sp-btn sp-pri"
            :disabled="!name.trim() || controller.isRunning.value"
            @click="shelve"
          >
            Shelve
          </button>
        </div>
      </div>
      <div
        v-else
        class="sp-body"
        role="status"
        aria-live="polite"
      >
        <p :class="{ 'sp-warn': step === 'failed' }">
          {{ progress }}
        </p>
        <div
          v-if="step === 'failed'"
          class="sp-actions"
        >
          <button
            type="button"
            class="sp-btn sp-pri"
            @click="shelve"
          >
            Try again
          </button>
        </div>
        <div
          v-if="step === 'done'"
          class="sp-actions"
        >
          <button
            type="button"
            class="sp-btn"
            @click="keepOpen = true"
          >
            Keep tab open
          </button>
        </div>
      </div>
    </template>

    <!-- ── Resume / delete ─────────────────────────────────── -->
    <template v-else>
      <div class="sp-body">
        <p
          v-if="loadError"
          class="sp-warn"
          role="alert"
        >
          {{ loadError }}
        </p>
        <p
          v-else-if="loading"
          class="sp-muted"
        >
          Loading shelved threads…
        </p>
        <p
          v-else-if="!visible.length"
          class="sp-muted"
        >
          {{ entries.length ? 'No shelved threads. Resumed ones are hidden.' : 'Nothing is shelved yet. Use /shelve in a thread to put it down.' }}
        </p>
        <ul
          v-else
          class="sp-rows"
        >
          <li
            v-for="entry in visible"
            :key="entry.fileId"
            class="sp-row"
            :class="{ 'sp-hit': entry.fileId === focusId }"
          >
            <div class="sp-row-main">
              <b>{{ entry.meta.name }}</b>
              <span class="sp-when">{{ shelvedWhen(entry) }}<template v-if="entry.meta.status === 'resumed'"> · resumed</template></span>
              <span class="sp-goal">{{ entry.goal || 'No goal recorded' }}</span>
            </div>
            <div
              v-if="confirmDelete !== entry.fileId"
              class="sp-row-acts"
            >
              <button
                type="button"
                class="sp-btn sp-pri"
                :disabled="busy"
                @click="resumeFresh(entry)"
              >
                Resume
              </button>
              <button
                type="button"
                class="sp-btn"
                :disabled="busy"
                @click="reopen(entry)"
              >
                Reopen original
              </button>
              <button
                type="button"
                class="sp-btn sp-danger"
                :disabled="busy"
                @click="askDelete(entry)"
              >
                Delete
              </button>
            </div>
            <div
              v-else
              class="sp-confirm"
              role="group"
              :aria-label="`Delete ${entry.meta.name}`"
            >
              <span>Move the note to the Files trash?</span>
              <label><input
                v-model="alsoConversation"
                type="checkbox"
              > Also remove the original conversation from History</label>
              <button
                type="button"
                class="sp-btn sp-danger-solid"
                :disabled="busy"
                @click="remove(entry)"
              >
                Delete
              </button>
              <button
                type="button"
                class="sp-btn"
                @click="confirmDelete = ''"
              >
                Cancel
              </button>
            </div>
            <p
              v-if="rowNotice[entry.fileId]"
              class="sp-warn"
              role="alert"
            >
              {{ rowNotice[entry.fileId] }}
            </p>
          </li>
        </ul>
        <label
          v-if="entries.some(e => e.meta.status === 'resumed')"
          class="sp-toggle"
        ><input
          v-model="showResumed"
          type="checkbox"
        > Show resumed</label>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, reactive, ref, type Ref } from 'vue';

import { useChatController } from '../../controller/useChatController';
import {
  extractHandoff, findEntry, handoffRequest, pickerEntries, RESUME_KEY, resumePrompt, slugify, type ShelfEntry, type ShelfMeta, type ShelfRequest,
} from '../../messages/shelfNote';
import { isLive, stopSummary, stopThreadAgents } from '../../messages/shelfStop';
import { restoreChatFromHistory } from '../../services/historyRestore';

import { useBrowserTabs } from '@pkg/composables/useBrowserTabs';
import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';
import { normalizeChatHeartbeatConfig } from '@pkg/shared/chatHeartbeat';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ request: ShelfRequest }>();
const emit = defineEmits<{ close: [] }>();

const REPLY_TIMEOUT_MS = 5 * 60_000;

const controller = useChatController();
const client = inject(AGENT_STATE_CLIENT_KEY);
if (!client) throw new Error('AgentStateClient is not provided');
const actions = new AgentActionController(ipcRenderer as any, client);
const context = inject<{ tabId?: string; backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
const { createTab, closeTab } = useBrowserTabs();

async function shelfIpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel as any, ...args) as { ok: boolean; value?: T; error?: string };
  if (!result?.ok) throw new Error(result?.error || 'Sulla Files did not respond');
  return result.value as T;
}

// ── Shelve ───────────────────────────────────────────────────────
const name = ref(props.request.name || controller.thread.value.title || 'thread');
const step = ref<'confirm' | 'working' | 'failed' | 'done'>('confirm');
const progress = ref('');
const busy = ref(false);
const keepOpen = ref(false);
const previewSlug = computed(() => slugify(name.value));
const threadRows = (threadId?: string) => (threadId ? new AgentTreeBuilder(client.snapshot.value.rows).flatten(new AgentTreeBuilder(client.snapshot.value.rows).forThread(threadId)).map(node => node.row) : []);
const liveRows = computed(() => threadRows(context.backendThreadId.value).filter(isLive));
const heartbeatOn = computed(() => controller.heartbeat.value.intervalMinutes !== null);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitForReply(after: number): Promise<string> {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  await sleep(500);
  while (Date.now() < deadline) {
    if (!controller.isRunning.value) {
      const reply = [...controller.messages.value].reverse().find(msg => msg.kind === 'sulla' && msg.createdAt >= after);
      if (reply?.kind === 'sulla' && reply.text.trim()) return reply.text;
    }
    await sleep(1_000);
  }
  throw new Error('Sulla did not write the handoff note within 5 minutes.');
}

async function shelve(): Promise<void> {
  if (busy.value || controller.isRunning.value) return;
  busy.value = true;
  step.value = 'working';
  try {
    progress.value = 'Asking agents to save their work…';
    const stopped = await stopThreadAgents({
      rows:     () => threadRows(context.backendThreadId.value),
      message:  (row, text) => actions.message(row, text),
      stop:     row => actions.stop(row),
      sleep,
      now:      () => Date.now(),
      progress: text => { progress.value = `${ text }…` },
    });
    const hadHeartbeat = heartbeatOn.value;
    if (hadHeartbeat) {
      progress.value = 'Turning off the heartbeat…';
      const config = normalizeChatHeartbeatConfig({ ...controller.heartbeat.value, intervalMinutes: null });
      controller.setHeartbeat(config);
      if (context.backendThreadId.value) await ipcRenderer.invoke('chat-heartbeat:set', { threadId: context.backendThreadId.value, config }).catch(() => undefined);
    }
    progress.value = 'Sulla is writing the handoff note…';
    const sentAt = Date.now();
    controller.send(handoffRequest(name.value.trim(), stopSummary(stopped, hadHeartbeat)));
    const body = extractHandoff(await waitForReply(sentAt));
    progress.value = 'Saving the note…';
    const meta: ShelfMeta = {
      name:            name.value.trim(),
      status:          'shelved',
      shelvedAt:       new Date().toISOString(),
      chatThreadId:    controller.thread.value.id,
      backendThreadId: context.backendThreadId.value,
      tabTitle:        controller.thread.value.title,
      tabId:           context.tabId,
      agentId:         controller.thread.value.agentId ?? undefined,
    };
    const saved = await shelfIpc<{ path: string }>('thread-shelf:save', meta, body);
    await shelfIpc('thread-shelf:archive-conversation', controller.thread.value.id, context.backendThreadId.value).catch(() => false);
    step.value = 'done';
    progress.value = `Shelved to ${ saved.path }. Closing this tab…`;
    setTimeout(() => { if (!keepOpen.value && context.tabId) closeTab(context.tabId); }, 3_000);
  } catch (error) {
    step.value = 'failed';
    progress.value = `Shelving stopped: ${ error instanceof Error ? error.message : String(error) }. Anything already stopped stays stopped.`;
  } finally { busy.value = false }
}

// ── Resume / delete ──────────────────────────────────────────────
const entries = ref<ShelfEntry[]>([]);
const loading = ref(false);
const loadError = ref('');
const showResumed = ref(false);
const confirmDelete = ref('');
const alsoConversation = ref(false);
const rowNotice = reactive<Record<string, string>>({});
const focusId = ref('');
const visible = computed(() => pickerEntries(entries.value, showResumed.value));

function shelvedWhen(entry: ShelfEntry): string {
  const d = new Date(entry.meta.shelvedAt);
  return Number.isNaN(d.getTime()) ? '' : `shelved ${ d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } ${ d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }`;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try { entries.value = await shelfIpc<ShelfEntry[]>('thread-shelf:list') } catch (error) {
    loadError.value = `Could not read shelved threads: ${ error instanceof Error ? error.message : String(error) }`;
  } finally { loading.value = false }
}

function openTab(title: string) {
  const tab = createTab('about:blank', { mode: 'chat', title });
  setTimeout(() => window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } })), 0);
  return tab;
}

function resumeFresh(entry: ShelfEntry): void {
  const tab = openTab(entry.meta.name);
  try { localStorage.setItem(RESUME_KEY(tab.id), JSON.stringify({ prompt: resumePrompt(entry), agentId: entry.meta.agentId ?? null, fileId: entry.fileId })) } catch { /* the new tab just opens empty */ }
  emit('close');
}

async function reopen(entry: ShelfEntry): Promise<void> {
  // Reopen in the ORIGINAL tab id, the one path History uses: the tab id is what
  // links the chat pointer and the persona's backend thread. A fresh tab id opens blank.
  const tab = restoreChatFromHistory({
    id: entry.meta.tabId || entry.meta.chatThreadId, type: 'chat', tab_id: entry.meta.tabId, thread_id: entry.meta.chatThreadId, title: entry.meta.tabTitle || entry.meta.name,
  });
  setTimeout(() => window.dispatchEvent(new CustomEvent('sulla:navigate-tab', { detail: { tabId: tab.id } })), 0);
  await shelfIpc('thread-shelf:mark-resumed', entry.fileId, entry.meta.chatThreadId).catch(() => undefined);
  emit('close');
}

function askDelete(entry: ShelfEntry): void {
  delete rowNotice[entry.fileId];
  const live = threadRows(entry.meta.backendThreadId).filter(isLive);
  if (live.length) {
    rowNotice[entry.fileId] = `Stop ${ live.map(row => row.label).join(', ') } first; it is still running.`;
    return;
  }
  alsoConversation.value = false;
  confirmDelete.value = entry.fileId;
}

async function remove(entry: ShelfEntry): Promise<void> {
  busy.value = true;
  try {
    await shelfIpc('thread-shelf:trash', entry.fileId);
    if (alsoConversation.value) await shelfIpc('thread-shelf:delete-conversation', entry.meta.chatThreadId, entry.meta.backendThreadId);
    entries.value = entries.value.filter(e => e.fileId !== entry.fileId);
    confirmDelete.value = '';
  } catch (error) {
    rowNotice[entry.fileId] = `Could not delete: ${ error instanceof Error ? error.message : String(error) }`;
  } finally { busy.value = false }
}

onMounted(async() => {
  if (props.request.mode === 'shelve') return;
  await load();
  if (!props.request.name) return;
  const hit = findEntry(entries.value, props.request.name);
  if (!hit) { loadError.value = `No shelved thread named "${ props.request.name }".`; return }
  showResumed.value = hit.meta.status === 'resumed';
  focusId.value = hit.fileId;
  if (props.request.mode === 'delete') askDelete(hit);
  else resumeFresh(hit);
});

</script>

<style scoped>
.sp {
  margin-bottom: 8px; border: 1px solid var(--border-default); border-radius: 10px;
  background: var(--bg-surface); color: var(--text-secondary); font-size: 13px;
}
.sp-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border-default); }
.sp-head b { color: var(--text-primary); font-weight: 600; }
.sp-gap { flex: 1; }
.sp-body { padding: 10px 12px 12px; max-height: min(50vh, 440px); overflow: auto; }
.sp-body p { margin: 0 0 8px; }
.sp-muted { color: var(--text-muted); }
.sp-warn { color: var(--status-error); }
.sp-label { color: var(--text-primary); }
.sp-field { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.sp-field span { color: var(--text-muted); min-width: 44px; }
.sp-field input {
  flex: 1; height: 30px; padding: 0 10px; border: 1px solid var(--border-default); border-radius: 7px;
  background: var(--bg-page, var(--bg-surface)); color: var(--text-primary); font: inherit;
}
.sp-field input:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
.sp-list { margin: 0 0 10px; padding-left: 18px; }
.sp-list li { margin: 3px 0; }
.sp-list b { color: var(--text-primary); font-weight: 600; }
.sp-list code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
.sp-actions { display: flex; gap: 6px; }
.sp-btn {
  display: inline-flex; align-items: center; height: 28px; padding: 0 10px; border: 1px solid var(--border-default);
  border-radius: 6px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12.5px; white-space: nowrap; cursor: pointer;
}
.sp-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent); }
.sp-btn:disabled { opacity: .45; cursor: default; }
.sp-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.sp-pri { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent, var(--bg-page)); font-weight: 600; }
.sp-pri:hover:not(:disabled) { color: var(--text-on-accent, var(--bg-page)); }
.sp-danger:hover:not(:disabled) { color: var(--status-error); border-color: var(--status-error); }
.sp-danger-solid { background: var(--status-error); border-color: var(--status-error); color: var(--text-on-accent, var(--bg-page)); font-weight: 600; }
.sp-rows { list-style: none; margin: 0; padding: 0; }
.sp-row { padding: 9px 0; border-top: 1px solid var(--border-default); }
.sp-row:first-child { border-top: 0; padding-top: 0; }
.sp-row.sp-hit .sp-row-main b { color: var(--accent); }
.sp-row-main { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: baseline; margin-bottom: 6px; }
.sp-row-main b { color: var(--text-primary); font-weight: 600; }
.sp-when { color: var(--text-muted); font: 12px var(--font-mono, ui-monospace, monospace); }
.sp-goal { grid-column: 1 / -1; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-row-acts { display: flex; gap: 6px; flex-wrap: wrap; }
.sp-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.sp-confirm label, .sp-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); }
.sp-toggle { margin-top: 8px; font-size: 12px; }
</style>
