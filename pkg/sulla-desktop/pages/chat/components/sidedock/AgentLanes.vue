<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  The side dock's Sulla tab: what needs you, then one compact lane per agent
  in this chat (two short lines: name, task, time, actions; then the latest
  step and a 10-minute activity meter). Child agents sit indented under their
  parent; finished agents fold into "Finished". Reads the agent state rows the
  status line uses; actions go through the same AgentActionController.
-->
<template>
  <div class="ln">
    <!-- One line that answers "is anything waiting on me, and is the rest moving?" -->
    <p
      class="ln-sum"
      :class="`ln-sum-${summary.state}`"
    >
      <span
        class="ln-sum-dot"
        aria-hidden="true"
      /><b>{{ summary.lead }}</b><template
        v-for="part in summary.parts"
        :key="part"
      >
        <span class="ln-sum-sep">·</span>{{ part }}
      </template>
    </p>
    <div
      v-if="!needsYou.length && !live.length && !finished.length"
      class="ln-empty"
    >
      Nothing running in this chat.
    </div>
    <div
      v-else
      class="ln-list"
    >
      <div
        v-for="msg in needsYou"
        :key="msg.id"
        class="ln-row ln-you"
      >
        <span class="ln-av ln-av-you">S</span>
        <div class="ln-main">
          <div class="ln-l1">
            <b>Sulla needs you</b><span
              class="ln-task"
              :title="needText(msg)"
            >· {{ needText(msg) }}</span>
            <span class="ln-sp" />
            <span class="ln-time">{{ age(msg.createdAt) }}</span>
            <button
              type="button"
              class="ln-answer"
              @click="jump(msg.id)"
            >
              {{ msg.kind === 'tool_approval' ? 'Review' : 'Answer' }}
            </button>
          </div>
        </div>
      </div>

      <div
        v-for="node in live"
        :key="node.row.key"
        class="ln-row ln-agent"
        :class="{ 'ln-child': node.indent > 0, 'ln-open': expanded === node.row.key, 'ln-stalled': node.row.state === 'quiet' && !node.row.runtimeAlive }"
        :style="node.indent ? { '--ln-indent': `${node.indent * 20}px` } : undefined"
        @click="onRowClick($event, node.row.key)"
      >
        <!-- The task leads; the agent is the avatar (initials, model tag, full name on hover). -->
        <span
          class="ln-av"
          :class="{ 'ln-spin': SPINNING.has(node.row.state) }"
          :title="node.parentLabel ? `${node.row.agentId || 'agent'} · started by ${node.parentLabel}` : (node.row.agentId || 'agent')"
        >{{ initials(node.row) }}<small v-if="modelTag(node.row)">{{ modelTag(node.row) }}</small></span>
        <div class="ln-main">
          <div class="ln-l1">
            <b
              class="ln-task"
              :title="node.row.label"
            >{{ node.row.label }}</b>
            <span class="ln-time">{{ timeText(node.row) }}</span>
            <span class="ln-acts">
              <button
                v-if="node.row.canMessage"
                type="button"
                class="ln-ib"
                title="Message this agent"
                aria-label="Message this agent"
                @click="toggleMessage(node.row.key)"
              ><svg viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z" /></svg></button>
              <button
                v-if="node.row.canOpen"
                type="button"
                class="ln-ib"
                title="Open this agent"
                aria-label="Open this agent"
                @click="openAgent(node.row)"
              ><svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></svg></button>
              <button
                v-if="node.row.canStop"
                type="button"
                class="ln-ib ln-stop"
                :class="{ 'ln-confirm': confirmStop === node.row.key }"
                :title="confirmStop === node.row.key ? 'Click again to stop' : 'Stop this agent'"
                :aria-label="confirmStop === node.row.key ? 'Click again to stop' : 'Stop this agent'"
                @click.stop="stop(node.row)"
              ><svg viewBox="0 0 24 24"><rect
                x="7"
                y="7"
                width="10"
                height="10"
                rx="1.5"
              /></svg></button>
            </span>
            <button
              type="button"
              class="ln-chev"
              :aria-expanded="expanded === node.row.key"
              :aria-label="expanded === node.row.key ? 'Hide details' : 'Show details'"
              @click.stop="toggleExpand(node.row.key)"
            >
              ▸
            </button>
          </div>
          <div class="ln-l2">
            <span
              v-if="waitTarget(node.row) === 'github'"
              class="ln-wait"
              title="Waiting on GitHub: its checks or tests are running"
            >GitHub</span>
            <span
              class="ln-step"
              :title="laneStep(node.row, now)"
            >{{ laneStep(node.row, now) }}</span>
            <span
              class="ln-meter"
              aria-hidden="true"
            ><i
              v-for="(count, index) in bins(node.row.key)"
              :key="index"
              :style="{ height: `${count ? Math.min(12, 3 + count * 3) : 1}px` }"
            /></span>
          </div>
          <dl
            v-if="expanded === node.row.key"
            class="ln-more"
          >
            <dt>Agent</dt><dd>
              {{ node.row.agentId || 'agent' }}<template v-if="node.parentLabel">
                · started by {{ node.parentLabel }}
              </template>
            </dd>
            <dt>Task</dt><dd>{{ node.row.label }}</dd>
            <dt>Latest</dt><dd>{{ laneStep(node.row, now) }}</dd>
            <template v-if="node.row.startedAt">
              <dt>Started</dt><dd>{{ LineTimes.shortTime(Date.parse(node.row.startedAt)) }} · {{ age(Date.parse(node.row.startedAt)) }} ago</dd>
            </template>
            <template v-if="node.row.lastCheckinSummary">
              <dt>Check-in</dt><dd>
                {{ shortenHashes(node.row.lastCheckinSummary) }}<template v-if="node.row.lastCheckinAt">
                  · {{ age(Date.parse(node.row.lastCheckinAt)) }} ago
                </template>
              </dd>
            </template>
          </dl>
          <div
            v-if="messaging.has(node.row.key) || (expanded === node.row.key && node.row.canMessage)"
            class="ln-msg"
          >
            <input
              v-model="drafts[node.row.key]"
              :aria-label="`Message ${node.row.agentId || 'agent'}`"
              placeholder="Steer this agent, e.g. skip docs-only PRs"
              @keydown.enter="send(node.row)"
            >
            <button
              type="button"
              :disabled="!drafts[node.row.key]?.trim()"
              @click="send(node.row)"
            >
              Send
            </button>
          </div>
          <p
            v-if="notice[node.row.key]"
            class="ln-notice"
          >
            {{ notice[node.row.key] }}
          </p>
        </div>
      </div>

      <details
        v-if="finished.length"
        class="ln-fin"
      >
        <summary><span class="ln-dot" />Finished · {{ finished.length }}<span class="ln-sp" />▾</summary>
        <div
          v-for="row in finished"
          :key="row.key"
          class="ln-fr"
        >
          <span
            class="ln-dot"
            :class="`ln-dot-${row.state}`"
          />
          <span class="ln-fr-label">{{ row.label }}</span>
          <span class="ln-sp" />
          <span class="ln-time">{{ row.state === 'done' ? '' : row.state }} {{ row.endedAt ? age(Date.parse(row.endedAt)) : '' }}</span>
          <button
            v-if="resultMessageFor(row)"
            type="button"
            class="ln-jump"
            @click="jump(resultMessageFor(row)!)"
          >
            Jump to
          </button>
        </div>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue';

import { useChatController } from '../../controller/useChatController';
import { LineTimes } from '../../messages/lineTime';
import { ActivityTrail, activityBins, laneStep, shortenHashes } from '../../messages/sideDock';
import { activityAge, deriveThreadActivity, waitTarget } from '../../messages/threadActivity';

import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder, type AgentTreeNode } from '@pkg/services/agentState/AgentTreeBuilder';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { ProactiveMessage, ToolApprovalMessage, ToolQuestionMessage } from '../../models/Message';

const LIVE = new Set<AgentStateRow['state']>(['queued', 'working', 'parked', 'quiet', 'blocked']);
const SPINNING = new Set<AgentStateRow['state']>(['queued', 'working']);

const controller = useChatController();
const client = inject(AGENT_STATE_CLIENT_KEY);
if (!client) throw new Error('AgentStateClient is not provided');
const actions = new AgentActionController(ipcRenderer as any, client);
const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });

const now = ref(Date.now());
const trail = new ActivityTrail();
const messaging = reactive(new Set<string>());
const drafts = reactive<Record<string, string>>({});
const notice = reactive<Record<string, string>>({});
const confirmStop = ref('');
/** One lane open at a time, so the list stays compact. */
const expanded = ref('');
function toggleExpand(key: string): void { expanded.value = expanded.value === key ? '' : key }
/** A click anywhere on the lane (not on its buttons or the steer box) opens or closes its details. */
function onRowClick(event: MouseEvent, key: string): void {
  if ((event.target as HTMLElement).closest('button, input, a, .ln-msg')) return;
  toggleExpand(key);
}
/** The model family from the agent's id: codex-sol-worker → sol, opus-worker → opus. */
function modelTag(row: AgentStateRow): string {
  const parts = (row.agentId || '').replace(/[-_]?worker$/i, '').split(/[-_]/).filter(Boolean);
  return (parts[parts.length - 1] ?? '').slice(0, 5);
}

const tree = computed(() => (context.backendThreadId.value
  ? new AgentTreeBuilder(client.snapshot.value.rows).forThread(context.backendThreadId.value)
  : []));

/** Live agents with their live descendants, indented by nesting; a live child of a finished parent is lifted up. */
const live = computed(() => {
  const out: { row: AgentStateRow; indent: number; parentLabel?: string }[] = [];
  const walk = (nodes: readonly AgentTreeNode[], indent: number, parent?: AgentStateRow) => {
    for (const node of nodes) {
      if (LIVE.has(node.row.state)) {
        out.push({ row: node.row, indent, parentLabel: parent ? (parent.agentId || parent.label) : undefined });
        walk(node.children, indent + 1, node.row);
      } else {
        walk(node.children, indent, parent);
      }
    }
  };
  walk(tree.value, 0);
  return out;
});
const finished = computed(() => new AgentTreeBuilder([]).flatten(tree.value).map(node => node.row)
  .filter(row => !LIVE.has(row.state))
  .sort((a, b) => Date.parse(b.endedAt ?? b.lastActivityAt) - Date.parse(a.endedAt ?? a.lastActivityAt)));
/** The thread in one line, worded for the side column: says "Nothing needs you" outright when that is true. */
const summary = computed(() => {
  const activity = deriveThreadActivity({ running: controller.isRunning.value, messages: controller.messages.value, agents: live.value.map(node => node.row), heartbeatMinutes: null });
  if (activity.state === 'you') return { state: 'you', lead: 'Needs you', parts: activity.parts };
  // A stopped agent is worth a look: say so in red instead of "Nothing needs you".
  if (activity.state === 'stalled') return { state: 'stalled', lead: 'No progress', parts: activity.parts };
  return { state: activity.state, lead: 'Nothing needs you', parts: activity.state === 'idle' ? ['nothing running'] : activity.parts };
});
const needsYou = computed(() => controller.messages.value.filter((msg): msg is ToolQuestionMessage | ToolApprovalMessage =>
  (msg.kind === 'tool_question' && msg.status === 'pending') || (msg.kind === 'tool_approval' && msg.decision === 'pending')));

watch(() => client.snapshot.value.rows, rows => trail.record(rows, Date.now()), { immediate: true });

function needText(msg: ToolQuestionMessage | ToolApprovalMessage): string {
  if (msg.kind === 'tool_approval') return msg.reason || msg.command;
  return msg.questions.length > 1 ? `${ msg.questions.length } questions` : (msg.questions[0]?.question || 'a question');
}
function initials(row: AgentStateRow): string {
  const name = (row.agentId || row.label || 'A').replace(/[-_]?worker$/i, '');
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? 'A') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
}
function age(at: number): string { return Number.isFinite(at) ? activityAge(Math.max(0, now.value - at)) : '' }
function timeText(row: AgentStateRow): string {
  // A timer wait shows when it looks again; that says "scheduled, not stuck" better than a running clock.
  if (row.state === 'parked' && row.wakeAt) return LineTimes.shortTime(Date.parse(row.wakeAt)).replace(/\s?[AP]M$/i, '');
  if (row.state === 'parked' && row.stateReason === 'scheduled wake-up') return 'scheduled';
  const start = row.startedAt ? Date.parse(row.startedAt) : NaN;
  if (!Number.isFinite(start)) return '';
  const seconds = Math.max(0, Math.floor((now.value - start) / 1000));
  return seconds < 3600 ? `${ Math.floor(seconds / 60) }:${ String(seconds % 60).padStart(2, '0') }` : activityAge(seconds * 1000);
}
function bins(key: string): number[] { return activityBins(trail.times(key), now.value) }
function resultMessageFor(row: AgentStateRow): string | undefined {
  return controller.messages.value.find((msg): msg is ProactiveMessage => msg.kind === 'proactive' &&
    !!msg.result?.items.some(item => item.jobId === row.jobId && item.taskIndex === row.taskIndex))?.id;
}
function jump(messageId: string): void {
  window.dispatchEvent(new CustomEvent('chat:jump-to-message', { detail: { messageId } }));
}
function flash(key: string, text: string): void {
  notice[key] = text;
  setTimeout(() => { if (notice[key] === text) delete notice[key]; }, 4000);
}
function toggleMessage(key: string): void { if (messaging.has(key)) messaging.delete(key); else messaging.add(key); }
async function send(row: AgentStateRow): Promise<void> {
  const text = drafts[row.key]?.trim();
  if (!text) return;
  try {
    const result = await actions.message(row, text);
    flash(row.key, result.ok ? 'Sent.' : (result.stale ? 'This agent is no longer running.' : 'Could not deliver the message.'));
    if (result.ok) { drafts[row.key] = ''; messaging.delete(row.key) }
  } catch (error) { flash(row.key, error instanceof Error ? error.message : 'Could not deliver the message.') }
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

let timer: ReturnType<typeof setInterval> | null = null;
function clearConfirm(): void { confirmStop.value = '' }
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now() }, 1000);
  window.addEventListener('click', clearConfirm);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener('click', clearConfirm);
});
</script>

<style scoped src="../../styles/agent-lanes.css"></style>
