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
        <span>In this thread</span>
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
      <div
        class="ta-cols"
        aria-hidden="true"
      >
        <span>State</span><span>Item</span><span>Latest</span><span class="ta-r">Age</span><span />
      </div>

      <!-- Questions and approvals: answer them right here. -->
      <div
        v-for="msg in humanMessages"
        :key="msg.id"
        class="ta-item"
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
          <span class="ta-chip ta-chip-you"><span class="ta-dot ta-dot-you" />{{ CHIP.you }}</span>
          <span class="ta-name">{{ humanTitle(msg) }}</span>
          <span class="ta-last">{{ humanDetail(msg) }}</span>
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
        :class="{ 'ta-open': expanded.has(node.row.key) }"
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
            class="ta-chip"
            :class="`ta-chip-${rowState(node.row)}`"
          ><span
            class="ta-dot"
            :class="`ta-dot-${rowState(node.row)}`"
          />{{ rowChip(node.row) }}</span>
          <span class="ta-name">{{ node.row.label }}<small v-if="node.row.agentId">{{ node.row.agentId }}</small></span>
          <span
            class="ta-last"
            :title="rowDetail(node.row)"
          >{{ shortShas(rowDetail(node.row)) }}</span>
          <span class="ta-when">{{ age(Date.parse(node.row.lastActivityAt)) }}</span>
          <span class="ta-acts">
            <!-- Icon-sized like its siblings: a text button overflowed the fixed actions column. -->
            <button
              v-if="node.row.canMessage && rowState(node.row) === 'stalled'"
              type="button"
              class="ta-btn ta-icon"
              title="Nudge: ask for a status update"
              :aria-label="`Nudge ${node.row.label}`"
              :disabled="busy.has(`m:${node.row.key}`)"
              @click.stop="nudge(node.row)"
            ><svg
              viewBox="0 0 16 16"
              aria-hidden="true"
            ><path d="M8 2.5a3.5 3.5 0 0 0-3.5 3.5v2.2L3 10.5h10l-1.5-2.3V6A3.5 3.5 0 0 0 8 2.5zM6.5 12.5a1.5 1.5 0 0 0 3 0" /></svg></button>
            <button
              v-else-if="node.row.canMessage"
              type="button"
              class="ta-btn ta-icon"
              title="Message"
              :aria-label="`Message ${node.row.label}`"
              @click.stop="startMessage(node.row.key)"
            ><svg
              viewBox="0 0 16 16"
              aria-hidden="true"
            ><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" /></svg></button>
            <button
              v-if="node.row.canOpen && node.row.threadId"
              type="button"
              class="ta-btn ta-icon"
              title="Open"
              :aria-label="`Open ${node.row.label}`"
              @click.stop="openAgent(node.row)"
            ><svg
              viewBox="0 0 16 16"
              aria-hidden="true"
            ><path d="M6.5 3.5h-3v9h9v-3M9 3.5h3.5V7M12.5 3.5 7 9" /></svg></button>
            <button
              v-if="node.row.canStop"
              type="button"
              class="ta-btn ta-icon ta-danger"
              :title="confirmStop === node.row.key ? 'Click again to stop' : 'Stop'"
              :aria-label="confirmStop === node.row.key ? `Confirm stop ${node.row.label}` : `Stop ${node.row.label}`"
              :class="{ 'ta-confirm': confirmStop === node.row.key }"
              @click.stop="stop(node.row)"
            ><template v-if="confirmStop === node.row.key">Stop?</template><svg
              v-else
              viewBox="0 0 16 16"
              aria-hidden="true"
            ><rect
              x="4.5"
              y="4.5"
              width="7"
              height="7"
              rx="1.2"
              class="ta-fill"
            /></svg></button>
          </span>
        </div>
        <div
          v-if="expanded.has(node.row.key)"
          class="ta-body"
        >
          <dl class="ta-facts">
            <template v-if="node.row.lastCheckinSummary">
              <dt>{{ node.row.lastCheckinAt ? clock(node.row.lastCheckinAt) : 'Latest' }}</dt><dd>{{ node.row.lastCheckinSummary }}</dd>
            </template>
            <template v-if="node.row.stateReason">
              <dt>Status</dt><dd>{{ node.row.stateReason }}</dd>
            </template>
            <dt>Started</dt><dd>{{ node.row.startedAt ? clock(node.row.startedAt) : 'not yet' }}</dd>
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
                class="ta-chip"
                :class="`ta-chip-${rowState(kid.row)}`"
              ><span
                class="ta-dot"
                :class="`ta-dot-${rowState(kid.row)}`"
              />{{ rowChip(kid.row) }}</span>
              <span class="ta-last"><b>{{ kid.row.label }}</b> · {{ shortShas(rowDetail(kid.row)) }}</span>
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
          <p
            v-if="notice[node.row.key]"
            class="ta-notice"
            role="status"
          >
            {{ notice[node.row.key] }}
          </p>
        </div>
      </div>

      <div
        v-if="heartbeatMinutes"
        class="ta-item"
      >
        <div class="ta-head ta-static">
          <span class="ta-chip ta-chip-waiting"><span class="ta-dot ta-dot-waiting" />{{ CHIP.scheduled }}</span>
          <span class="ta-name">Heartbeat</span>
          <span class="ta-last">checks in every {{ heartbeatMinutes }} min</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue';

import { useChatController } from '../../controller/useChatController';
import { chatActivityByTab } from '../../messages/chatActivityStore';
import { activityAge, blockedDetail, deriveThreadActivity, parkedActivity, runningDetail, type ThreadActivityState } from '../../messages/threadActivity';
import ToolApproval from '../tool/ToolApproval.vue';
import ToolQuestion from '../tool/ToolQuestion.vue';

import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder, type AgentTreeNode } from '@pkg/services/agentState/AgentTreeBuilder';
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
// A live agent is listed with its live descendants nested under it. One whose
// parent has already finished is lifted to the top level, so a sub-agent still
// working under a done manager is not hidden (the Sub-agents panel lists it).
function liveTops(nodes: readonly AgentTreeNode[]): AgentTreeNode[] {
  return nodes.flatMap(node => (LIVE.has(node.row.state) ? [node] : liveTops(node.children)));
}
const agentNodes = computed(() => liveTops(tree.value));
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

function rowState(row: AgentStateRow): ThreadActivityState {
  if (row.state === 'quiet') return 'stalled';
  if (row.state === 'blocked') return 'waiting';
  if (row.state === 'parked') return parkedActivity(row).state;
  return 'working';
}
const CHIP = { working: 'Working', waiting: 'Waiting', idle: 'Idle', you: 'Needs you', stalled: 'No progress', starting: 'Starting', scheduled: 'Scheduled', blocked: 'Blocked' } as const;
function rowChip(row: AgentStateRow): string {
  if (row.state === 'queued') return CHIP.starting;
  if (row.state === 'blocked') return CHIP.blocked;
  return CHIP[rowState(row)];
}
/** Full commit hashes swamp a one-line summary; the full text stays in the title and the expanded detail. */
function shortShas(text: string): string { return text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1') }
function rowDetail(row: AgentStateRow): string {
  if (row.state === 'parked') return parkedActivity(row).detail;
  if (row.state === 'quiet') return `no check-in for ${ age(Date.parse(row.lastActivityAt)) }`;
  if (row.state === 'blocked') return blockedDetail(row);
  const running = runningDetail(row, now.value);
  if (running) return running;
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
/*
 * Theme text tokens are often the same hue as the surface (Ocean: blue on
 * blue), so labels here use neutral ink mixed from --text-primary and keep
 * colour for state. The tray drops to --bg-page so it reads as its own layer.
 */
.ta {
  --ta-ink-2: color-mix(in srgb, var(--text-primary) 78%, var(--bg-surface));
  --ta-ink-3: color-mix(in srgb, var(--text-primary) 58%, var(--bg-surface));
  --ta-well: var(--bg-page);
  --ta-well-raised: color-mix(in srgb, var(--bg-surface) 60%, var(--bg-page));
  --ta-cols: 104px minmax(0, 1.3fr) minmax(0, 1.5fr) 40px 92px;
  margin-bottom: 8px;
}
.ta-line {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px;
  padding: 0 12px; border: 1px solid var(--border-strong); border-radius: 10px;
  background: var(--ta-well); color: var(--ta-ink-2); font: inherit; font-size: 13px;
  text-align: left; cursor: pointer; transition: background-color .18s cubic-bezier(.22,1,.36,1), border-color .18s cubic-bezier(.22,1,.36,1);
}
.ta-line:hover:not(:disabled) { background: var(--ta-well-raised); }
.ta-line:disabled { cursor: default; }
.ta-line:focus-visible, .ta-head:focus-visible, .ta-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ta-lead { color: var(--text-primary); font-weight: 650; white-space: nowrap; }
.ta-sep { color: var(--ta-ink-3); }
.ta-part { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ta-age { margin-left: auto; color: var(--ta-ink-2); font: 12px var(--font-mono, ui-monospace, monospace); white-space: nowrap; }
.ta-chev { color: var(--ta-ink-2); transition: transform .2s cubic-bezier(.22,1,.36,1); }
.ta-line[aria-expanded="true"] .ta-chev { transform: rotate(180deg); }
.ta-line.ta-working { border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 12%, var(--ta-well)); color: var(--text-primary); }
.ta-line.ta-you { border-color: color-mix(in srgb, var(--status-warning) 55%, transparent); background: color-mix(in srgb, var(--status-warning) 10%, var(--ta-well)); }
.ta-line.ta-you .ta-lead { color: var(--status-warning); }
.ta-line.ta-stalled { border-color: color-mix(in srgb, var(--status-error) 55%, transparent); background: color-mix(in srgb, var(--status-error) 10%, var(--ta-well)); }
.ta-line.ta-stalled .ta-lead { color: var(--status-error); }
.ta-line.ta-idle { background: transparent; border-color: transparent; color: var(--ta-ink-3); }
.ta-line.ta-idle .ta-lead { color: var(--ta-ink-2); font-weight: 500; }

.ta-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.ta-dot-working { background: var(--accent); animation: ta-breathe 1.6s cubic-bezier(.22,1,.36,1) infinite; }
.ta-dot-waiting { background: color-mix(in srgb, var(--accent) 55%, var(--ta-ink-3)); }
.ta-dot-you { background: var(--status-warning); }
.ta-dot-stalled { background: var(--status-error); }
.ta-dot-idle { border: 1.5px solid var(--ta-ink-3); }
@keyframes ta-breathe {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) { .ta-dot-working { animation: none; } }

.ta-tray {
  container-type: inline-size;
  margin-top: 6px; max-height: min(52vh, 460px); overflow: auto;
  border: 1px solid var(--border-strong); border-radius: 12px; background: var(--ta-well);
  box-shadow: 0 18px 40px -20px rgba(0, 0, 0, .55);
}
.ta-trayhead {
  display: flex; align-items: center; gap: 8px; padding: 8px 14px;
  border-bottom: 1px solid var(--border-default); color: var(--text-primary); font-size: 12px; font-weight: 600;
}
.ta-sp { flex: 1; }
.ta-cols, .ta-head { display: grid; grid-template-columns: var(--ta-cols); gap: 12px; align-items: center; padding: 0 14px; }
.ta-cols { padding-top: 6px; padding-bottom: 6px; border-bottom: 1px solid var(--border-default); color: var(--ta-ink-3); font-size: 11.5px; }
.ta-r { text-align: right; }
.ta-item + .ta-item { border-top: 1px solid var(--border-default); }
.ta-head { min-height: 48px; padding-top: 7px; padding-bottom: 7px; cursor: pointer; font-size: 13px; }
.ta-head:hover, .ta-open > .ta-head, .ta-open > .ta-body { background: var(--ta-well-raised); }
.ta-head.ta-static { cursor: default; }
.ta-head.ta-static:hover { background: none; }

.ta-chip {
  display: inline-flex; align-items: center; gap: 6px; justify-self: start; height: 22px; padding: 0 8px;
  border-radius: 6px; font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap;
}
.ta-chip .ta-dot { width: 6px; height: 6px; }
.ta-chip-working { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.ta-chip-waiting { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--ta-ink-2); }
.ta-chip-idle { background: color-mix(in srgb, var(--text-primary) 8%, transparent); color: var(--ta-ink-2); }
.ta-chip-you { background: color-mix(in srgb, var(--status-warning) 18%, transparent); color: var(--status-warning); }
.ta-chip-stalled { background: color-mix(in srgb, var(--status-error) 18%, transparent); color: var(--status-error); }

.ta-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-weight: 650; }
.ta-name small { display: block; overflow: hidden; text-overflow: ellipsis; color: var(--ta-ink-3); font-size: 12px; font-weight: 400; }
.ta-last { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ta-ink-2); }
.ta-last b { color: var(--text-primary); font-weight: 600; }
.ta-when { color: var(--ta-ink-3); font: 12px var(--font-mono, ui-monospace, monospace); text-align: right; white-space: nowrap; }
.ta-acts { display: flex; gap: 4px; justify-content: flex-end; }
.ta-btn {
  display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 10px;
  border: 1px solid var(--border-strong); border-radius: 7px; background: transparent;
  color: var(--text-primary); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer;
}
.ta-btn:hover:not(:disabled) { border-color: var(--accent); }
.ta-btn:disabled { opacity: .45; cursor: default; }
.ta-btn.ta-icon { min-width: 28px; padding: 0 6px; color: var(--ta-ink-2); }
.ta-btn.ta-icon:hover:not(:disabled) { color: var(--text-primary); }
.ta-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
.ta-btn svg .ta-fill { fill: currentColor; stroke: none; }
.ta-btn.ta-danger { color: var(--status-error); }
.ta-btn.ta-danger:hover:not(:disabled), .ta-btn.ta-confirm { color: var(--status-error); border-color: var(--status-error); }
.ta-btn.ta-pri { height: 32px; padding: 0 14px; background: var(--accent); border-color: var(--accent); color: var(--bg-page); font-weight: 650; }

.ta-body { padding: 2px 14px 14px calc(104px + 26px); font-size: 13px; }
.ta-body.ta-card { padding-left: 14px; }
.ta-facts { display: grid; grid-template-columns: max-content 1fr; gap: 5px 14px; margin: 0 0 10px; }
.ta-facts dt { color: var(--ta-ink-3); font: 12px var(--font-mono, ui-monospace, monospace); }
.ta-facts dd { margin: 0; color: var(--text-primary); overflow-wrap: anywhere; }
.ta-kids { margin: 0 0 10px; border-top: 1px solid var(--border-default); }
.ta-kid { display: grid; grid-template-columns: 104px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border-default); }
.ta-msg { display: flex; gap: 8px; margin: 4px 0 0; }
.ta-msg input {
  flex: 1; min-width: 0; height: 32px; padding: 0 11px; border: 1px solid var(--border-strong); border-radius: 8px;
  background: var(--ta-well); color: var(--text-primary); font: inherit; font-size: 13px;
}
.ta-msg input::placeholder { color: var(--ta-ink-3); }
.ta-msg input:focus { outline: 2px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
.ta-notice { margin: 8px 0 0; color: var(--ta-ink-2); font-size: 12px; }

/* Narrow composer (side panel): stack each row instead of squeezing columns. */
@container (max-width: 560px) {
  .ta-cols { display: none; }
  .ta-head { grid-template-columns: minmax(0, 1fr) auto auto; row-gap: 4px; }
  .ta-head > .ta-chip { grid-column: 1 / -1; }
  .ta-head > .ta-last { grid-column: 1 / -1; grid-row: 3; }
  .ta-body { padding-left: 14px; }
}
</style>
