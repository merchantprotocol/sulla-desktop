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
    <button
      v-if="decisionStore.openCount.value"
      type="button"
      class="ln-for-you"
      @click="decisionStore.show()"
    >
      {{ decisionStore.openCount.value }} {{ decisionStore.openCount.value === 1 ? 'request' : 'requests' }} in For You
    </button>
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
      <details
        v-for="group in workGroups"
        :key="group.key"
        class="ln-work"
        :open="!collapsedGroups.has(group.key)"
        @toggle="toggleGroup(group.key, $event)"
      >
        <summary class="ln-work-heading">
          <span>{{ group.title }}</span><small>{{ agentCountSummary(group.nodes.filter(node => !node.context).map(node => node.row)) }}</small>
        </summary>
        <p class="ln-work-caption">
          {{ group.linked ? 'Agents connected to this work' : 'No recorded links to other work in this chat' }}
        </p>
        <div
          v-for="node in group.nodes"
          :key="node.row.key"
          class="ln-row ln-agent"
          :class="{ 'ln-child': node.indent > 0, 'ln-open': expanded === node.row.key, 'ln-context': node.context, 'ln-stalled': node.row.state === 'quiet' && !node.row.runtimeAlive }"
          :style="node.indent ? { '--ln-indent': `${Math.min(node.indent, 4) * 16}px` } : undefined"
          @click="onRowClick($event, node.row.key)"
        >
          <!-- The task leads; the agent is the avatar (initials, model tag, full name on hover). -->
          <span
            class="ln-av"
            :class="{ 'ln-spin': SPINNING.has(node.row.state) }"
            :title="node.parentLabel ? `${node.row.agentId || 'agent'} · started by ${node.parentLabel}` : (node.row.agentId || 'agent')"
          >{{ initials(node.row) }}</span>
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
            <p
              v-if="node.relationship"
              class="ln-relationship"
            >
              {{ node.relationship }}
            </p>
            <p
              v-if="node.context"
              class="ln-relationship"
            >
              Earlier task · {{ node.row.state === 'done' ? 'Reported done' : node.row.state }}
            </p>
            <div class="ln-l2">
              <span
                v-if="waitTarget(node.row) === 'github'"
                class="ln-wait"
                title="Waiting on GitHub: its checks or tests are running"
              >GitHub</span>
              <span
                class="ln-step"
                :title="laneStep(node.row, now)"
              >{{ AgentModelStatus.label(node.row.modelStatus) }} · {{ laneStep(node.row, now) }}</span>
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
              <dt>Model · effort</dt><dd>{{ AgentModelStatus.label(node.row.modelStatus) }}</dd>
              <dt>Agent</dt><dd>
                {{ node.row.agentId || 'agent' }}<template v-if="node.parentLabel">
                  · started by {{ node.parentLabel }}
                </template>
              </dd>
              <dt>Task</dt><dd>{{ node.row.label }}</dd>
              <template v-if="node.relationship">
                <dt>Connection</dt><dd>{{ node.relationship }}</dd>
              </template>
              <template v-if="node.row.taskId">
                <dt>Assigned task</dt><dd>{{ node.row.taskId }}</dd>
              </template>
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
      </details>

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

import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatController } from '../../controller/useChatController';
import { AgentWorkTree } from '../../messages/AgentWorkTree';
import { LineTimes } from '../../messages/lineTime';
import { ActivityTrail, activityBins, laneStep, shortenHashes } from '../../messages/sideDock';
import { activityAge, agentCountSummary, deriveThreadActivity, waitTarget } from '../../messages/threadActivity';

import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import { AgentTreeBuilder } from '@pkg/services/agentState/AgentTreeBuilder';
import { AgentModelStatus } from '@pkg/shared/agentState/AgentModelStatus';
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

const tree = computed(() => (context.backendThreadId.value
  ? new AgentTreeBuilder(client.snapshot.value.rows).forThread(context.backendThreadId.value)
  : []));

const workGroups = computed(() => AgentWorkTree.build(client.snapshot.value.rows, context.backendThreadId.value));
const live = computed(() => workGroups.value.flatMap(group => group.nodes).filter(node => AgentWorkTree.live(node.row)));
const collapsedGroups = reactive(new Set<string>());
function toggleGroup(key: string, event: Event): void {
  if ((event.target as HTMLDetailsElement).open) collapsedGroups.delete(key);
  else collapsedGroups.add(key);
}
const finished = computed(() => new AgentTreeBuilder([]).flatten(tree.value).map(node => node.row)
  .filter(row => !LIVE.has(row.state))
  .sort((a, b) => Date.parse(b.endedAt ?? b.lastActivityAt) - Date.parse(a.endedAt ?? a.lastActivityAt)));
/** Both status surfaces use the same activity wording and heartbeat schedule. */
const summary = computed(() => {
  const activity = deriveThreadActivity({ running: controller.isRunning.value, messages: controller.messages.value.filter(message => !['tool_question', 'tool_approval'].includes(message.kind)), agents: live.value.map(node => node.row), heartbeatMinutes: controller.heartbeat?.value.intervalMinutes ?? null });
  if (decisionStore.openCount.value) {
    // What waits on you is listed right below; the line counts it and says what the agents are doing.
    const agents = deriveThreadActivity({ running: controller.isRunning.value, messages: [], agents: live.value.map(node => node.row), heartbeatMinutes: controller.heartbeat?.value.intervalMinutes ?? null });
    const count = needsYou.value.length;
    return { state: 'you', lead: 'Needs you', parts: [`${ count } ${ count === 1 ? 'request' : 'requests' } in For You`, ...(agents.state === 'idle' ? [] : agents.parts)] };
  }
  return activity;
});
const decisionStore = ChatDecisions.useChatDecisions();
const needsYou = computed(() => ({ length: decisionStore.openCount.value }));

watch(() => client.snapshot.value.rows, rows => trail.record(rows, Date.now()), { immediate: true });

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
  const lastActive = age(Date.parse(row.lastActivityAt));
  return lastActive ? `last active ${ lastActive } ago` : '';
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
