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
    <!-- The line, then any trailing controls the host adds (the dock's move button), in one row. -->
    <div
      class="ta-row"
      :class="`ta-row-${activity.state}`"
    >
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
      <slot name="end" />
    </div>

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
        <span>State</span><span>Item</span><span>Latest</span><span class="ta-r">Time</span><span />
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
          <span class="ta-name" :style="{ paddingLeft: `${ Math.min(node.depth, 3) * 12 }px` }">{{ node.row.label }}<small v-if="node.row.agentId">{{ node.row.agentId }}</small></span>
          <span
            class="ta-last"
            :title="rowDetail(node.row)"
          >{{ shortShas(rowDetail(node.row)) }}</span>
          <span class="ta-when"><AgentActivityTime :row="node.row" /></span>
          <ThreadAgentActions
            :row="node.row"
            :stalled="rowState(node.row) === 'stalled'"
            :busy="busy.has(`m:${node.row.key}`)"
            :confirming="confirmStop === node.row.key"
            @nudge="nudge(node.row)"
            @message="startMessage(node.row.key)"
            @open="openAgent(node.row)"
            @stop="stop(node.row)"
          />
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

import ThreadAgentActions from './ThreadAgentActions.vue';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatController } from '../../controller/useChatController';
import { activityAge, blockedDetail, deriveThreadActivity, hasActiveChatWork, parkedActivity, quietDetail, runningDetail, waitTarget, type ThreadActivityState } from '../../messages/threadActivity';

import AgentActivityTime from '../chrome/AgentActivityTime.vue';

import { windowTabStripKey } from '@pkg/composables/WindowTabStripState';
import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';
import type { ChatTabActivitySnapshot } from '@pkg/shared/ChatTabActivity';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ToolApprovalMessage, ToolQuestionMessage } from '../../models/Message';

const NUDGE = 'Status check from the user: report your progress, or what is blocking you.';
const LIVE = new Set<AgentStateRow['state']>(['queued', 'working', 'parked', 'quiet', 'blocked']);

const controller = useChatController();
const { openCount } = ChatDecisions.useChatDecisions();
const windowTabStrip = inject(windowTabStripKey, null);
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
// Show every live descendant as a row without requiring its parent to expand.
const agentNodes = computed(() => new AgentTreeBuilder<AgentStateRow>([]).flatten(tree.value).filter(node => LIVE.has(node.row.state)));
const liveRows = computed(() => agentNodes.value.map(node => node.row));
const heartbeatMinutes = computed(() => controller.heartbeat.value.intervalMinutes ?? null);
const humanMessages = computed(() => controller.messages.value.filter((msg): msg is ToolQuestionMessage | ToolApprovalMessage =>
  (msg.kind === 'tool_question' && msg.status === 'pending') || (msg.kind === 'tool_approval' && msg.decision === 'pending')));

// For You requests live in the side dock's For You tab, not on this line (Jonathon, 2026-11-19).
const activity = computed(() => deriveThreadActivity({
  running:          controller.isRunning.value,
  messages:         controller.messages.value.filter(message => !['tool_question', 'tool_approval'].includes(message.kind)),
  agents:           liveRows.value,
  heartbeatMinutes: heartbeatMinutes.value,
}));
const hasItems = computed(() => agentNodes.value.length > 0 || !!heartbeatMinutes.value);
const stalledRows = computed(() => liveRows.value.filter(row => row.state === 'quiet' && row.canMessage));
const ageText = computed(() => {
  if (activity.value.state === 'idle') return '';
  const items = agentNodes.value.length;
  const last = activity.value.lastActivityAt;
  if (activity.value.state === 'working' && last) return `last activity ${ activityAge(now.value - last) } ago`;
  return items ? `${ items } item${ items === 1 ? '' : 's' }` : '';
});

function rowState(row: AgentStateRow): ThreadActivityState {
  if (row.state === 'quiet') return row.runtimeAlive ? 'quiet' : 'stalled';
  if (row.state === 'blocked') return 'waiting';
  if (row.state === 'parked') return parkedActivity(row).state;
  return 'working';
}
const CHIP = { working: 'Working', waiting: 'Waiting', idle: 'Idle', you: 'Needs you', stalled: 'No progress', quiet: 'Quiet', starting: 'Starting', scheduled: 'Scheduled', blocked: 'Blocked' } as const;
function rowChip(row: AgentStateRow): string {
  if (row.state === 'queued') return CHIP.starting;
  if (waitTarget(row) === 'github') return 'On GitHub';
  if (row.state === 'blocked') return CHIP.blocked;
  return CHIP[rowState(row)];
}
/** Full commit hashes swamp a one-line summary; the full text stays in the title and the expanded detail. */
function shortShas(text: string): string { return text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1') }
function rowDetail(row: AgentStateRow): string {
  if (row.state === 'parked') return parkedActivity(row).detail;
  if (row.state === 'quiet') return quietDetail(row, now.value);
  if (row.state === 'blocked') return blockedDetail(row);
  const running = runningDetail(row, now.value);
  if (running) return running;
  return row.lastCheckinSummary || row.stateReason || (row.state === 'queued' ? 'starting' : 'working');
}
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

function reportTabActivity(snapshot: ChatTabActivitySnapshot): void {
  if (!context.tabId) return;
  windowTabStrip?.setSnapshot(context.tabId, snapshot);
  window.dispatchEvent(new CustomEvent('sulla:chat-activity', {
    detail: { tabId: context.tabId, ...snapshot },
  }));
}

// Include the short reason so the shell can show useful attention summaries
// even when this chat lives in its own process-per-tab renderer.
watch([
  () => openCount.value ? 'you' as const : activity.value.state === 'you' ? 'waiting' as const : activity.value.state,
  () => openCount.value
    ? `${ openCount.value } pending request${ openCount.value === 1 ? '' : 's' }`
    : activity.value.parts.slice(0, 2).join(' · ').slice(0, 240),
  () => hasActiveChatWork(controller.isRunning.value, liveRows.value),
], ([state, detail, active]) => {
  reportTabActivity({ state, detail, active });
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
  if (context.tabId) {
    reportTabActivity({ state: 'idle', detail: 'nothing running or scheduled' });
    windowTabStrip?.clearSnapshot(context.tabId);
  }
});
</script>

<style scoped src="../../styles/thread-status-line.css"></style>
