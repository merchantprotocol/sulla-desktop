<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<!--
  Recorded handoffs and unlinked activity for the current chat.
-->
<template>
<div ref="panel" class="ln">
  <p class="ln-sum" :class="`ln-sum-${summary.state}`">
    <span class="ln-sum-dot" aria-hidden="true" /><b>{{ summary.lead }}</b>
    <template v-for="part in summary.parts" :key="part">
      <span class="ln-sum-sep">·</span>{{ part }}
    </template>
  </p>
  <button v-if="recorded.length" type="button" class="ln-history" @click="emit('show-history')">View full history</button>
  <button v-if="decisionStore.openCount.value" type="button" class="ln-for-you" @click="openForYou()">Open Decide</button>
  <p v-if="outcomesLoading && outcomes.length" class="ln-outcome-refresh" role="status">Refreshing saved outcomes…</p>
  <p v-else-if="outcomesError" class="ln-outcome-error" role="status">
    Saved outcome history may be stale. <button type="button" @click="emit('retry-outcomes')">Try again</button>
  </p>
  <div v-if="!live.length && !finished.length && !decisionStore.openCount.value && !outcomes.length && !outcomesLoading && !outcomesError" class="ln-empty">
    No agent activity in this chat.
  </div>
  <details
    v-for="section in sections"
    :key="section.key"
    class="ln-work"
    :open="sectionOpen(section)"
    @toggle="rememberSection(section, $event)"
  >
    <summary class="ln-work-heading"><span>{{ section.title }}</span><small>{{ section.summary }}</small></summary>
    <div class="ln-work-body">
      <AgentHandoffMap :nodes="section.nodes" :draw-links="section.map" v-slot="{ node }">
        <div v-if="node.links.length" class="ln-relationships">
          <div v-for="link in node.links" :key="`${link.kind}-${link.key}`">
            {{ link.kind === 'assignment' ? 'Assigned by' : 'Follows' }}
            <button v-if="nodeFor(link.key)" type="button" class="ln-link" @click="revealJob(link.key)">{{ relationTitle(link.key) }}</button>
            <span v-else>earlier job unavailable</span>
          </div>
        </div>
        <div class="ln-job-card" :class="{ 'ln-job-open': expanded.has(node.row.key) }">
          <button
            type="button"
            class="ln-job"
            :aria-expanded="expanded.has(node.row.key)"
            :aria-controls="detailId(node.row.key)"
            :data-job-key="node.row.key"
            @click="toggleExpand(node.row.key)"
          >
            <span class="ln-chevron" aria-hidden="true" />
            <span class="ln-job-title" :title="node.row.label">{{ jobTitle(section, node) }}</span>
            <span class="ln-job-state" :class="`ln-job-${node.row.state}`">{{ jobState(node.row) }}</span>
            <span class="ln-job-meta">
              {{ modelCaption(node.row) }}<span class="ln-time"><AgentActivityTime :row="node.row" /></span>
              <template v-if="node.row.state === 'parked' && node.row.wakeAt"> · Next check <AgentActivityTime :at="node.row.wakeAt" event="Next check" /></template>
              <template v-if="outcomesByJob.has(node.row.key)"> · 1 report</template>
            </span>
          </button>
          <div v-show="expanded.has(node.row.key)" :id="detailId(node.row.key)" class="ln-detail">
            <template v-if="expanded.has(node.row.key)">
              <p v-if="node.row.stateReason || node.row.lastCheckinSummary || AgentWorkTree.live(node.row)" class="ln-latest">{{ laneStep(node.row, now) }}</p>
              <dl class="ln-more">
                <dt>Agent</dt><dd>{{ node.row.agentId || 'Agent' }}</dd>
                <template v-if="node.row.taskId"><dt>Project task</dt><dd>{{ node.row.taskId }}</dd></template>
                <template v-if="node.row.modelStatus?.model && responseFor(node.row)">
                  <dt>{{ selectionSource(node.row) }}</dt><dd>{{ formatModel(node.row.modelStatus) }}</dd>
                </template>
                <template v-if="!responseFor(node.row)"><dt>Recorded response</dt><dd>No model output recorded</dd></template>
                <template v-if="node.row.jobRestartResumeCount">
                  <dt>Job recovery</dt><dd>Resumed {{ node.row.jobRestartResumeCount }} {{ node.row.jobRestartResumeCount === 1 ? 'time' : 'times' }}</dd>
                </template>
                <template v-for="decision in linkedQuestions(node.row)" :key="decision.id">
                  <dt>Related request</dt><dd><button type="button" class="ln-link" @click="openForYou(decision.id)">{{ decision.title || 'Open Decide' }}</button></dd>
                </template>
              </dl>
              <div class="ln-actions">
                <button v-if="node.row.canOpen" type="button" @click="openAgent(node.row)">Open agent</button>
                <button v-if="node.row.canMessage" type="button" @click="toggleMessage(node.row.key)">Message</button>
                <button v-if="node.row.canStop" type="button" class="ln-stop" @click.stop="stop(node.row)">{{ confirmStop === node.row.key ? 'Click again to stop' : 'Stop agent' }}</button>
                <button v-if="resultMessageFor(node.row)" type="button" @click="jump(resultMessageFor(node.row)!)">View report</button>
              </div>
              <div v-if="node.row.canMessage && messaging.has(node.row.key)" class="ln-msg">
                <input v-model="drafts[node.row.key]" :aria-label="`Message ${node.row.agentId || 'agent'}`" placeholder="Message this agent" @keydown.enter="send(node.row)">
                <button type="button" :disabled="!drafts[node.row.key]?.trim()" @click="send(node.row)">Send</button>
              </div>
              <p v-if="notice[node.row.key]" class="ln-notice" role="status">{{ notice[node.row.key] }}</p>
              <WorkOutcomeCard
                v-if="outcomesByJob.get(node.row.key)"
                class="ln-job-report"
                :group="outcomesByJob.get(node.row.key)!"
                :focus-key="outcomeTarget === node.row.key ? outcomeTarget : undefined"
                owned
              />
            </template>
          </div>
        </div>
      </AgentHandoffMap>
      <div v-if="outcomesBySection.get(section.key)?.length" class="ln-outcomes ln-build-outcomes">
        <h3>Reports for this work</h3>
        <WorkOutcomeCard
          v-for="outcome in outcomesBySection.get(section.key)"
          :key="outcome.key"
          :group="outcome"
          :focus-key="focusReport(outcome)"
        />
      </div>
    </div>
  </details>
  <details v-if="recentOutcomes.length" class="ln-work ln-recent-outcomes" :open="!live.length || !!focusedRecent">
    <summary class="ln-work-heading"><span>Recent outcomes</span><small>{{ recentOutcomes.length }}</small></summary>
    <div class="ln-work-body ln-outcomes">
      <WorkOutcomeCard
        v-for="outcome in visibleRecent"
        :key="outcome.key"
        :group="outcome"
        :focus-key="focusReport(outcome)"
        recent
      />
      <button v-if="recentOutcomes.length > visibleRecent.length" type="button" class="ln-earlier-outcomes" @click="showEarlier = true">
        Show earlier outcomes · {{ recentOutcomes.length - visibleRecent.length }}
      </button>
    </div>
  </details>
  <p v-else-if="outcomesLoading && !outcomes.length" class="ln-empty" role="status">Loading saved outcomes…</p>
</div>
</template>
<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch, type Ref } from 'vue';

import AgentHandoffMap from './AgentHandoffMap.vue';
import WorkOutcomeCard from './WorkOutcomeCard.vue';
import { ChatDecisions } from '../../composables/useChatDecisions';
import { useChatController } from '../../controller/useChatController';
import { AgentLaneProjection, type AgentLaneSection } from '../../messages/AgentLaneProjection';
import { AgentWorkTree, type AgentWorkNode } from '../../messages/AgentWorkTree';
import type { ThreadWorkstream } from '../../messages/ThreadGoalProgress';
import { laneStep } from '../../messages/sideDock';
import { deriveThreadActivity } from '../../messages/threadActivity';
import AgentActivityTime from '../chrome/AgentActivityTime.vue';
import { AgentActionController } from '@pkg/services/agentState/AgentActionController';
import { AGENT_STATE_CLIENT_KEY } from '@pkg/services/agentState/AgentStateInjection';
import type { AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import { DecisionAttention } from '@pkg/shared/decisionAttention';
import type { WorkflowRunRow } from '@pkg/shared/productOwnerWorkflow';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { ProactiveMessage } from '../../models/Message';

const controller = useChatController();
const client = inject(AGENT_STATE_CLIENT_KEY);
if (!client) throw new Error('AgentStateClient is not provided');
const actions = new AgentActionController(ipcRenderer as any, client);
const projection = new AgentLaneProjection();
const context = inject<{ backendThreadId: Ref<string | undefined> }>('chat:activity-context', { backendThreadId: ref(undefined) });
const now = ref(Date.now());
const messaging = reactive(new Set<string>());
const drafts = reactive<Record<string, string>>({});
const notice = reactive<Record<string, string>>({});
const confirmStop = ref('');
const expanded = reactive(new Set<string>());
const detailsPrefix = useId();
const detailId = (key: string) => `${ detailsPrefix }-job-${ key }`;
function toggleExpand(key: string): void {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
}

const props = withDefaults(defineProps<{
  outcomes?: ThreadWorkstream[];
  outcomesError?: boolean;
  outcomesLoading?: boolean;
  outcomeTarget?: string;
}>(), { outcomes: () => [] });
const emit = defineEmits<{ (event: 'show-for-you' | 'show-history' | 'retry-outcomes'): void }>();
const decisionStore = ChatDecisions.useChatDecisions();
function openForYou(id?: string): void {
  decisionStore.show(id);
  emit('show-for-you');
}
const threadId = context.backendThreadId;
const snapshot = computed(() => client.snapshot.value.rows);
const scoped = computed(() => snapshot.value.filter(row => row.rootThreadId === threadId.value));
const live = computed(() => scoped.value.filter(AgentWorkTree.live));
const saved = ref<{ threadId?: string; rows: WorkflowRunRow[] }>({ rows: [] });
const historySignal = computed(() => scoped.value.map(row => `${ row.key }:${ row.state }:${ row.endedAt ?? '' }`).sort().join('|'));

// The Sulla overview keeps the current tree after its last worker returns. The
// Full history opens from this overview; this read supplies durable tree links.
watch([threadId, historySignal], async([id], _, onCleanup) => {
  if (!id) {
    saved.value = { rows: [] };
    return;
  }
  let cancelled = false;
  onCleanup(() => { cancelled = true });
  try {
    const rows = await ipcRenderer.invoke('chat-workflow:history', id);
    if (!cancelled && Array.isArray(rows)) saved.value = { threadId: id, rows };
  } catch {
    // A missing endpoint stays visible in the inspector as unavailable.
  }
}, { immediate: true });

const recorded = computed(() => {
  const rows = new Map<string, AgentStateRow>();
  if (saved.value.threadId === threadId.value) {
    for (const row of saved.value.rows) rows.set(row.key, projection.historyRow(row));
  }
  // A recent snapshot carries current controls and updates. A saved terminal
  // state wins over a delayed live snapshot that has not settled yet.
  for (const row of scoped.value) {
    const stored = rows.get(row.key);
    if (stored && !AgentWorkTree.live(stored) && AgentWorkTree.live(row)) {
      rows.set(row.key, { ...row, ...stored, responseModels: stored.responseModels?.length ? stored.responseModels : row.responseModels });
    } else {
      rows.set(row.key, { ...stored, ...row, responseModels: row.responseModels?.length ? row.responseModels : stored?.responseModels });
    }
  }
  return [...rows.values()];
});

const leadMessage = computed(() => controller.messages.value.findLast(message => message.kind === 'sulla'));

const workGroups = computed(() => {
  const activeKeys = new Set(live.value.map(row => row.key));
  const recentKeys = new Set(scoped.value.map(row => row.key));
  const current = AgentWorkTree.current(recorded.value, threadId.value, activeKeys, recentKeys);
  const lead = projection.chatLeadRow(threadId.value, current, activeKeys, leadMessage.value);
  if (!lead) return [];
  const connected = current.map(row => AgentWorkTree.links(row).length
    ? row
    : { ...row, parentJobId: lead.jobId, parentTaskIndex: lead.taskIndex });
  const title = activeKeys.size ? 'Current work' : 'Latest handoff';
  return AgentWorkTree.build([lead, ...connected], threadId.value, { includeSettled: true })
    .map(group => ({ ...group, title }));
});
const finished = computed(() => {
  const shown = new Set(workGroups.value.flatMap(group => group.nodes.map(node => node.row.key)));
  return scoped.value.filter(row => !AgentWorkTree.live(row) && !shown.has(row.key))
    .sort((a, b) => Date.parse(b.endedAt ?? b.lastActivityAt) - Date.parse(a.endedAt ?? a.lastActivityAt));
});

const sections = computed(() => projection.sections(workGroups.value, finished.value));

const panel = ref<HTMLElement>();
const jobs = computed(() => new Map(sections.value.flatMap(section =>
  section.nodes.map(node => [node.row.key, { node, section }] as const))));
const placements = computed(() => projection.placements(props.outcomes, jobs.value));
const outcomesByJob = computed(() => placements.value.byJob);
const outcomesBySection = computed(() => placements.value.bySection);
const recentOutcomes = computed(() => placements.value.recent);
const focusedReport = computed(() => props.outcomeTarget ? placements.value.targets.get(props.outcomeTarget) : undefined);
const focusedRecent = computed(() => !!focusedReport.value && !focusedReport.value.section);
function focusReport(outcome: ThreadWorkstream): string | undefined {
  return outcome.steps.some(step => step.report && step.key === props.outcomeTarget) ? props.outcomeTarget : undefined;
}

const showEarlier = ref(false);
const visibleRecent = computed(() => {
  if (showEarlier.value) return recentOutcomes.value;
  return recentOutcomes.value.filter((group, index) => index < 6 || (focusedRecent.value && !!focusReport(group)));
});
const sectionPreferences = reactive(new Map<string, boolean>());
watch(threadId, () => {
  expanded.clear();
  showEarlier.value = false;
  sectionPreferences.clear();
});
watch([() => props.outcomeTarget, () => focusedReport.value?.section, () => focusedReport.value?.job, focusedRecent], async([target, section, job]) => {
  if (!target || !focusedReport.value) return;
  if (section) sectionPreferences.set(section, true);
  if (job) expanded.add(job);
  await nextTick();
  const report = [...panel.value?.querySelectorAll<HTMLElement>('[data-report-key]') ?? []]
    .find(element => element.dataset.reportKey === target);
  const headline = report?.querySelector<HTMLElement>('summary');
  headline?.scrollIntoView?.({ block: 'nearest' });
  headline?.focus({ preventScroll: true });
}, { immediate: true, flush: 'post' });
function sectionOpen(section: AgentLaneSection): boolean {
  return sectionPreferences.get(section.key) ?? (section.defaultOpen || section.nodes.some(node => expanded.has(node.row.key)));
}
function rememberSection(section: AgentLaneSection, event: Event): void {
  const open = (event.currentTarget as HTMLDetailsElement).open;
  if (open !== sectionOpen(section)) sectionPreferences.set(section.key, open);
}
async function revealJob(key: string): Promise<void> {
  const entry = jobs.value.get(key);
  if (!entry) return;
  sectionPreferences.set(entry.section.key, true);
  expanded.add(key);
  await nextTick();
  const header = [...panel.value?.querySelectorAll<HTMLButtonElement>('[data-job-key]') ?? []]
    .find(button => button.dataset.jobKey === key);
  header?.scrollIntoView?.({ block: 'nearest' });
  header?.focus({ preventScroll: true });
}
function jobTitle(section: AgentLaneSection, node: AgentWorkNode): string {
  const { row } = node;
  if (section.map && row.label === section.title && row.agentId) {
    return row.agentId.replace(/(^|[-_])([a-z])/g, (_, divider: string, letter: string) => (divider ? ' ' : '') + letter.toUpperCase());
  }
  return row.label;
}
function nodeFor(key: string): AgentWorkNode | undefined { return jobs.value.get(key)?.node }
function relationTitle(key: string): string {
  const entry = jobs.value.get(key);
  return entry ? jobTitle(entry.section, entry.node) : '';
}
function linkedQuestions(row: AgentStateRow) {
  const ids = row.decisionIds ?? [];
  return ids.length ? decisionStore.decisions.value.filter(record => ids.includes(record.id) && DecisionAttention.active(record, now.value)) : [];
}

const summary = computed(() => {
  const activity = deriveThreadActivity({
    running:          controller.isRunning.value,
    messages:         controller.messages.value.filter(message => !['tool_question', 'tool_approval'].includes(message.kind)),
    agents:           live.value,
    heartbeatMinutes: controller.heartbeat?.value.intervalMinutes ?? null,
    now:              now.value,
  });
  const count = decisionStore.openCount.value;
  if (!count) return activity;
  return {
    state: 'you', lead: 'Needs you',
    parts: [`${count} ${count === 1 ? 'request' : 'requests'} in Decide`, ...(activity.state === 'idle' ? [] : activity.parts)],
  };
});

const jobState = (row: AgentStateRow) => projection.jobState(row);
const responseFor = (row: AgentStateRow) => projection.responseFor(row);
const formatModel = (model?: Parameters<AgentLaneProjection['formatModel']>[0]) => projection.formatModel(model);
const selectionSource = (row: AgentStateRow) => projection.selectionSource(row);
const modelCaption = (row: AgentStateRow) => projection.modelCaption(row);
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
