<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  One always-present line above the message box that says what this thread
  is doing (working / waiting / needs you / no progress / idle). Click it to
  open a dropdown where each item can be expanded and acted on in place:
  answer questions, message, nudge, stop or open agents.
-->
<template>
  <div class="ta">
    <button
      type="button"
      class="ta-line"
      :class="`ta-${activity.state}`"
      :aria-expanded="open"
      aria-controls="ta-tray"
      :disabled="!hasItems"
      @click="open = !open"
    >
      <span
        class="ta-dot"
        :class="`ta-dot-${activity.state}`"
      />
      <span class="ta-lead">{{ activity.lead }}</span>
      <template
        v-for="part in activity.parts"
        :key="part"
      >
        <span class="ta-sep">·</span><span class="ta-part">{{ part }}</span>
      </template>
      <span
        v-if="ageText"
        class="ta-age"
      >{{ ageText }}</span>
      <span
        v-if="hasItems"
        class="ta-chev"
        aria-hidden="true"
      >⌄</span>
    </button>

    <div
      v-if="open && hasItems"
      id="ta-tray"
      class="ta-tray"
      role="region"
      aria-label="Activity in this thread"
    >
      <div class="ta-trayhead">
        ACTIVITY IN THIS THREAD
        <span class="ta-sp" />
        <button
          v-if="stalledRows.length > 1"
          type="button"
          class="ta-btn"
          @click="nudgeAll"
        >
          Nudge all stalled
        </button>
      </div>

      <!-- Questions and approvals: answer them right here. -->
      <div
        v-for="msg in humanMessages"
        :key="msg.id"
        class="ta-item ta-you"
        :class="{ 'ta-open': expanded.has(msg.id) }"
      >
        <div
          class="ta-head"
          role="button"
          tabindex="0"
          :aria-expanded="expanded.has(msg.id)"
          @click="toggle(msg.id)"
          @keydown.enter.prevent="toggle(msg.id)"
          @keydown.space.prevent="toggle(msg.id)"
        >
          <span class="ta-dot ta-dot-you" />
          <span class="ta-title"><b>{{ humanTitle(msg) }}</b> <span>· {{ humanDetail(msg) }}</span></span>
          <span class="ta-when">{{ age(msg.createdAt) }}</span>
          <span class="ta-acts">
            <button
              type="button"
              class="ta-btn"
              @click.stop="jumpTo(msg.id)"
            >Jump to card</button>
          </span>
        </div>
        <div
          v-if="expanded.has(msg.id)"
          class="ta-body ta-card"
        >
          <ToolQuestion
            v-if="msg.kind === 'tool_question'"
            :msg="msg"
          />
          <ToolApproval
            v-else
            :msg="msg"
          />
        </div>
      </div>

      <!-- Agents launched from this thread. -->
      <div
        v-for="node in agentNodes"
        :key="node.row.key"
        class="ta-item"
        :class="[`ta-${rowState(node.row)}`, { 'ta-open': expanded.has(node.row.key) }]"
      >
        <div
          class="ta-head"
          role="button"
          tabindex="0"
          :aria-expanded="expanded.has(node.row.key)"
          @click="toggle(node.row.key)"
          @keydown.enter.prevent="toggle(node.row.key)"
          @keydown.space.prevent="toggle(node.row.key)"
        >
          <span
            class="ta-dot"
            :class="`ta-dot-${rowState(node.row)}`"
          />
          <span class="ta-title"><b>{{ node.row.label }}</b> <span>· {{ rowDetail(node.row) }}</span></span>
          <span class="ta-when">{{ age(Date.parse(node.row.lastActivityAt)) }}</span>
          <span class="ta-acts">
            <button
              v-if="node.row.canMessage && rowState(node.row) === 'stalled'"
              type="button"
              class="ta-btn"
              :disabled="busy.has(`m:${node.row.key}`)"
              @click.stop="nudge(node.row)"
            >Nudge</button>
            <button
              v-else-if="node.row.canMessage"
              type="button"
              class="ta-btn"
              @click.stop="startMessage(node.row.key)"
            >Message</button>
            <button
              v-if="node.row.canStop"
              type="button"
              class="ta-btn ta-icon ta-danger"
              :title="confirmStop === node.row.key ? 'Click again to stop' : 'Stop'"
              :aria-label="confirmStop === node.row.key ? `Confirm stop ${node.row.label}` : `Stop ${node.row.label}`"
              :class="{ 'ta-confirm': confirmStop === node.row.key }"
              @click.stop="stop(node.row)"
            >{{ confirmStop === node.row.key ? 'Stop?' : '■' }}</button>
          </span>
        </div>
        <div
          v-if="expanded.has(node.row.key)"
          class="ta-body"
        >
          <dl class="ta-facts">
            <template v-if="node.row.lastCheckinSummary">
              <dt>{{ node.row.lastCheckinAt ? clock(node.row.lastCheckinAt) : 'latest' }}</dt><dd>{{ node.row.lastCheckinSummary }}</dd>
            </template>
            <template v-if="node.row.stateReason">
              <dt>status</dt><dd>{{ node.row.stateReason }}</dd>
            </template>
            <dt>agent</dt><dd>{{ node.row.agentId || 'agent' }} · started {{ node.row.startedAt ? clock(node.row.startedAt) : 'not yet' }}</dd>
          </dl>
          <div
            v-if="node.children.length"
            class="ta-kids"
          >
            <div
              v-for="kid in node.children"
              :key="kid.row.key"
              class="ta-kid"
            >
              <span
                class="ta-dot"
                :class="`ta-dot-${rowState(kid.row)}`"
              />
              <span class="ta-title">{{ kid.row.label }} <span>· {{ rowDetail(kid.row) }}</span></span>
              <span class="ta-when">{{ age(Date.parse(kid.row.lastActivityAt)) }}</span>
            </div>
          </div>
          <form
            v-if="node.row.canMessage"
            class="ta-msg"
            @submit.prevent="send(node.row)"
          >
            <input
              :ref="el => { if (el) inputs[node.row.key] = el as HTMLInputElement }"
              v-model="drafts[node.row.key]"
              :aria-label="`Message ${node.row.label}`"
              placeholder="Steer this agent, e.g. skip docs-only PRs"
            >
            <button
              type="submit"
              class="ta-btn ta-pri"
              :disabled="!drafts[node.row.key]?.trim() || busy.has(`m:${node.row.key}`)"
            >
              Send
            </button>
          </form>
          <div class="ta-row">
            <button
              v-if="node.row.canOpen && node.row.threadId"
              type="button"
              class="ta-btn"
              @click="openAgent(node.row)"
            >
              Open
            </button>
            <span
              v-if="notice[node.row.key]"
              class="ta-notice"
              role="status"
            >{{ notice[node.row.key] }}</span>
          </div>
        </div>
      </div>

      <div
        v-if="heartbeatMinutes"
        class="ta-item"
      >
        <div class="ta-head ta-static">
          <span class="ta-dot ta-dot-waiting" />
          <span class="ta-title"><b>Heartbeat</b> <span>· checks in every {{ heartbeatMinutes }} min</span></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue';

import { useChatController } from '../../controller/useChatController';
import { chatActivityByTab } from '../../messages/chatActivityStore';
import { activityAge, deriveThreadActivity, type ThreadActivityState } from '../../messages/threadActivity';
import ToolApproval from '../tool/ToolApproval.vue';
import ToolQuestion from '../tool/ToolQuestion.vue';

import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ToolApprovalMessage, ToolQuestionMessage } from '../../models/Message';

const NUDGE = 'Status check from the user: report your progress, or what is blocking you.';
const LIVE = new Set<AgentStateRow['state']>(['queued', 'working', 'parked', 'quiet', 'blocked']);

const controller = useChatController();
const client = inject(AGENT_STATE_CLIENT_KEY);
if (!client) throw new Error('AgentStateClient is not provided');
const actions = new AgentActionController(ipcRenderer as any, client);
const context = inject<{ tabId?: string; backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });

const now = ref(Date.now());
const open = ref(false);
const expanded = reactive(new Set<string>());
const busy = reactive(new Set<string>());
const drafts = reactive<Record<string, string>>({});
const notice = reactive<Record<string, string>>({});
const inputs: Record<string, HTMLInputElement> = {};
const confirmStop = ref('');

const tree = computed(() => context.backendThreadId.value
  ? new AgentTreeBuilder(client.snapshot.value.rows).forThread(context.backendThreadId.value)
  : []);
const agentNodes = computed(() => tree.value.filter(node => LIVE.has(node.row.state)));
const liveRows = computed(() => new AgentTreeBuilder([]).flatten(agentNodes.value).map(node => node.row).filter(row => LIVE.has(row.state)));
const heartbeatMinutes = computed(() => controller.heartbeat.value.intervalMinutes ?? null);
const humanMessages = computed(() => controller.messages.value.filter((msg): msg is ToolQuestionMessage | ToolApprovalMessage =>
  (msg.kind === 'tool_question' && msg.status === 'pending') || (msg.kind === 'tool_approval' && msg.decision === 'pending')));

const activity = computed(() => deriveThreadActivity({
  running:          controller.isRunning.value,
  messages:         controller.messages.value,
  agents:           liveRows.value,
  heartbeatMinutes: heartbeatMinutes.value,
}));
const hasItems = computed(() => humanMessages.value.length + agentNodes.value.length > 0 || !!heartbeatMinutes.value);
const stalledRows = computed(() => liveRows.value.filter(row => row.state === 'quiet' && row.canMessage));
const ageText = computed(() => {
  if (activity.value.state === 'idle') return '';
  const items = humanMessages.value.length + agentNodes.value.length;
  const last = activity.value.lastActivityAt;
  if (activity.value.state === 'working' && last) return `last activity ${ activityAge(now.value - last) } ago`;
  return items ? `${ items } item${ items === 1 ? '' : 's' }` : '';
});

function rowState(row: AgentStateRow): Exclude<ThreadActivityState, 'idle'> {
  if (row.state === 'quiet') return 'stalled';
  if (row.state === 'blocked') return 'you';
  if (row.state === 'parked') return 'waiting';
  return 'working';
}
function rowDetail(row: AgentStateRow): string {
  if (row.state === 'parked') return `waiting on ${ row.waitingOnChildren } agent${ row.waitingOnChildren === 1 ? '' : 's' }`;
  if (row.state === 'quiet') return `no check-in for ${ age(Date.parse(row.lastActivityAt)) }`;
  return row.lastCheckinSummary || row.stateReason || (row.state === 'queued' ? 'starting' : 'working');
}
function humanTitle(msg: ToolQuestionMessage | ToolApprovalMessage): string {
  return msg.kind === 'tool_question' ? (msg.questions[0]?.header || 'Question') : 'Approval';
}
function humanDetail(msg: ToolQuestionMessage | ToolApprovalMessage): string {
  if (msg.kind === 'tool_approval') return msg.reason || msg.command;
  return msg.questions.length > 1 ? `${ msg.questions.length } questions to answer` : (msg.questions[0]?.question || 'waiting for your answer');
}
function age(at: number): string { return Number.isFinite(at) ? activityAge(now.value - at) : '' }
function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${ d.getHours() }:${ String(d.getMinutes()).padStart(2, '0') }`;
}
function toggle(key: string): void { if (expanded.has(key)) expanded.delete(key); else expanded.add(key); }
function flash(key: string, text: string): void {
  notice[key] = text;
  setTimeout(() => { if (notice[key] === text) delete notice[key]; }, 4000);
}

async function message(row: AgentStateRow, text: string): Promise<boolean> {
  busy.add(`m:${ row.key }`);
  try {
    const result = await actions.message(row, text);
    flash(row.key, result.ok ? 'Sent.' : (result.stale ? 'This agent is no longer running.' : 'Could not deliver the message.'));
    return result.ok;
  } catch (error) {
    flash(row.key, error instanceof Error ? error.message : 'Could not deliver the message.');
    return false;
  } finally { busy.delete(`m:${ row.key }`) }
}
async function nudge(row: AgentStateRow): Promise<void> {
  expanded.add(row.key);
  await message(row, NUDGE);
}
async function nudgeAll(): Promise<void> { await Promise.all(stalledRows.value.map(row => nudge(row))) }
async function send(row: AgentStateRow): Promise<void> {
  const text = drafts[row.key]?.trim();
  if (text && await message(row, text)) drafts[row.key] = '';
}
async function startMessage(key: string): Promise<void> {
  expanded.add(key);
  await nextTick();
  inputs[key]?.focus();
}
async function stop(row: AgentStateRow): Promise<void> {
  if (confirmStop.value !== row.key) { confirmStop.value = row.key; return }
  confirmStop.value = '';
  try {
    const result = await actions.stop(row);
    flash(row.key, result.ok ? 'Stop requested.' : 'Already stopped.');
  } catch (error) { flash(row.key, error instanceof Error ? error.message : 'Could not stop it.') }
}
async function openAgent(row: AgentStateRow): Promise<void> {
  const opened = await ipcRenderer.invoke('agents:open-job-in-tab' as any, row.jobId, row.rootThreadId || context.backendThreadId.value, row.taskIndex).catch(() => false);
  if (!opened) flash(row.key, 'Could not open it; it may have finished.');
}
function jumpTo(messageId: string): void {
  open.value = false;
  window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId } }));
}

// Tab dots: tell the tab strip what this thread is doing.
watch(() => activity.value.state, state => {
  if (context.tabId) chatActivityByTab.set(context.tabId, state);
}, { immediate: true });
watch(hasItems, has => { if (!has) open.value = false; });

let timer: ReturnType<typeof setInterval> | null = null;
function clearConfirm(): void { confirmStop.value = '' }
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now() }, 1000);
  window.addEventListener('click', clearConfirm);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener('click', clearConfirm);
  if (context.tabId) chatActivityByTab.delete(context.tabId);
});
</script>

<style scoped>
.ta { margin-bottom: 8px; }
.ta-line {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px;
  padding: 0 12px; border: 1px solid var(--border-default); border-radius: 9px;
  background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 13px;
  text-align: left; cursor: pointer; transition: background-color .18s cubic-bezier(.22,1,.36,1), border-color .18s cubic-bezier(.22,1,.36,1);
}
.ta-line:hover:not(:disabled) { background: var(--bg-surface-alt, var(--bg-surface)); }
.ta-line:disabled { cursor: default; }
.ta-line:focus-visible, .ta-head:focus-visible, .ta-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ta-lead { color: var(--text-primary); font-weight: 600; white-space: nowrap; }
.ta-sep { color: var(--text-muted); }
.ta-part { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ta-age { margin-left: auto; color: var(--text-muted); font: 12px var(--font-mono, ui-monospace, monospace); white-space: nowrap; }
.ta-chev { color: var(--text-muted); transition: transform .2s cubic-bezier(.22,1,.36,1); }
.ta-line[aria-expanded="true"] .ta-chev { transform: rotate(180deg); }
.ta-line.ta-you { border-color: color-mix(in srgb, var(--status-warning) 55%, transparent); background: color-mix(in srgb, var(--status-warning) 9%, var(--bg-surface)); }
.ta-line.ta-you .ta-lead { color: var(--status-warning); }
.ta-line.ta-stalled { border-color: color-mix(in srgb, var(--status-error) 55%, transparent); background: color-mix(in srgb, var(--status-error) 9%, var(--bg-surface)); }
.ta-line.ta-stalled .ta-lead { color: var(--status-error); }
.ta-line.ta-idle { background: transparent; border-color: transparent; color: var(--text-muted); }
.ta-line.ta-idle .ta-lead { color: var(--text-muted); font-weight: 500; }

.ta-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ta-dot-working { background: var(--accent); animation: ta-breathe 1.6s cubic-bezier(.22,1,.36,1) infinite; }
.ta-dot-waiting { background: color-mix(in srgb, var(--accent) 55%, var(--text-muted)); }
.ta-dot-you { background: var(--status-warning); }
.ta-dot-stalled { background: var(--status-error); }
.ta-dot-idle { border: 1.5px solid var(--text-muted); }
@keyframes ta-breathe {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) { .ta-dot-working { animation: none; } }

.ta-tray {
  margin-top: 6px; max-height: min(52vh, 460px); overflow: auto;
  border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface);
}
.ta-trayhead {
  display: flex; align-items: center; gap: 8px; padding: 7px 12px;
  border-bottom: 1px solid var(--border-default); color: var(--text-muted);
  font: 11px var(--font-mono, ui-monospace, monospace); letter-spacing: .06em;
}
.ta-sp { flex: 1; }
.ta-item + .ta-item { border-top: 1px solid var(--border-default); }
.ta-head {
  display: grid; grid-template-columns: 14px minmax(0, 1fr) auto auto; gap: 10px; align-items: center;
  padding: 8px 12px; cursor: pointer; font-size: 13px;
}
.ta-head:hover, .ta-open > .ta-head { background: var(--bg-surface-alt, var(--bg-surface)); }
.ta-head.ta-static { cursor: default; grid-template-columns: 14px minmax(0, 1fr); }
.ta-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
.ta-title b { color: var(--text-primary); font-weight: 600; }
.ta-you > .ta-head .ta-title b { color: var(--status-warning); }
.ta-stalled > .ta-head .ta-title b { color: var(--status-error); }
.ta-when { color: var(--text-muted); font: 12px var(--font-mono, ui-monospace, monospace); white-space: nowrap; }
.ta-acts { display: flex; gap: 4px; }
.ta-btn {
  display: inline-flex; align-items: center; justify-content: center; height: 26px; padding: 0 9px;
  border: 1px solid var(--border-default); border-radius: 6px; background: transparent;
  color: var(--text-secondary); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer;
}
.ta-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent); }
.ta-btn:disabled { opacity: .45; cursor: default; }
.ta-btn.ta-icon { min-width: 26px; padding: 0 6px; }
.ta-btn.ta-danger:hover:not(:disabled), .ta-btn.ta-confirm { color: var(--status-error); border-color: var(--status-error); }
.ta-btn.ta-pri { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent, var(--bg-page)); font-weight: 600; }
.ta-body { padding: 4px 12px 12px 36px; font-size: 13px; }
.ta-body.ta-card { padding-left: 12px; }
.ta-facts { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; margin: 2px 0 8px; }
.ta-facts dt { color: var(--text-muted); font: 11.5px var(--font-mono, ui-monospace, monospace); }
.ta-facts dd { margin: 0; color: var(--text-secondary); overflow-wrap: anywhere; }
.ta-kids { margin: 2px 0 10px; padding-left: 12px; border-left: 1px solid var(--border-default); }
.ta-kid { display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 4px 0; }
.ta-msg { display: flex; gap: 6px; margin: 4px 0 8px; }
.ta-msg input {
  flex: 1; min-width: 0; height: 30px; padding: 0 10px; border: 1px solid var(--border-default); border-radius: 7px;
  background: var(--bg-page, var(--bg-surface)); color: var(--text-primary); font: inherit; font-size: 13px;
}
.ta-msg input:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
.ta-row { display: flex; align-items: center; gap: 8px; }
.ta-notice { color: var(--text-muted); font-size: 12px; }
</style>
