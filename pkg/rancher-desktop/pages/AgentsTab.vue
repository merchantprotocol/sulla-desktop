<template>
  <div
    class="agents-page"
    :class="{ dark: isDark }"
  >
    <AgentConversations
      v-if="selectedAgent"
      class="conversation-view"
      :channel="selectedAgent.channel"
      :agent-name="selectedAgent.name"
      :tick="pollTick"
      @close="selectedAgent = null"
    />

    <main
      v-else
      class="live-view"
    >
      <header class="page-head">
        <div>
          <h1>Live</h1>
          <p>Every agent running on this desktop right now, grouped by lead agent and chat.</p>
        </div>
        <div
          class="stream-state"
          :class="{ offline: !polling }"
        >
          <i aria-hidden="true" />
          <span>{{ polling ? `streaming · updated ${updatedAgo}` : 'updates paused' }}</span>
        </div>
      </header>

      <section
        class="summary-grid"
        aria-label="Live agent summary"
      >
        <article class="summary-card">
          <div class="summary-label">
            <i class="status-dot running" />Agents running
          </div>
          <strong>{{ runningCount }}</strong>
          <span>{{ leadRunningCount }} leads · {{ subagentRunningCount }} sub-agents</span>
        </article>
        <article class="summary-card">
          <div class="summary-label">
            Sub-agents
          </div>
          <strong>{{ subagentCount }}</strong>
          <span>{{ depthLabel }}</span>
        </article>
        <article class="summary-card warning">
          <div class="summary-label">
            <i class="status-dot waiting" />Waiting on a person
          </div>
          <strong>{{ waitingCount }}</strong>
          <span>{{ waitingCount ? 'A reply can unblock this work' : 'Nothing needs a reply' }}</span>
        </article>
        <article class="summary-card danger">
          <div class="summary-label">
            <i class="status-dot problem" />Stuck / failed
          </div>
          <strong>{{ problemCount }}</strong>
          <span>{{ problemSummary }}</span>
        </article>
        <article
          v-if="tokenTotal !== null"
          class="summary-card"
        >
          <div class="summary-label">
            Tokens · 24h
          </div>
          <strong>{{ compactNumber(tokenTotal) }}</strong>
          <span>Recorded local usage</span>
        </article>
      </section>

      <section
        class="filters"
        aria-label="Agent filters"
      >
        <div class="segments">
          <button
            v-for="option in filterOptions"
            :key="option.key"
            type="button"
            :class="{ active: activeFilter === option.key }"
            @click="activeFilter = option.key"
          >
            {{ option.label }} <span>{{ option.count }}</span>
          </button>
        </div>
        <label class="search-box">
          <svg
            viewBox="0 0 20 20"
            aria-hidden="true"
          ><circle
            cx="8.5"
            cy="8.5"
            r="5.5"
          /><path d="m13 13 4 4" /></svg>
          <input
            v-model.trim="search"
            type="search"
            placeholder="Search agents or work"
            aria-label="Search live agents"
          >
        </label>
      </section>

      <section
        class="tree-card"
        aria-label="Live agents"
      >
        <div class="table-row table-head">
          <div>Agent</div>
          <div class="working-column">
            Working on
          </div>
          <div>Activity</div>
          <div>Check-in</div>
          <div>Elapsed</div>
          <div class="actions-heading">
            Actions
          </div>
        </div>

        <div
          v-if="loading"
          class="empty-state"
        >
          Loading live agents…
        </div>
        <div
          v-else-if="filteredGroups.length === 0"
          class="empty-state"
        >
          {{ search || activeFilter !== 'all' ? 'No agents match these filters.' : 'Nothing is running right now.' }}
        </div>

        <article
          v-for="group in filteredGroups"
          :key="group.id"
          class="agent-group"
        >
          <div
            class="table-row lead-row"
            :class="rowClass(group.leadStatus)"
          >
            <div class="agent-cell">
              <button
                v-if="group.children.length"
                class="chevron"
                type="button"
                :aria-label="collapsedGroups.has(group.id) ? 'Expand group' : 'Collapse group'"
                @click="toggleGroup(group.id)"
              >
                <svg
                  :class="{ collapsed: collapsedGroups.has(group.id) }"
                  viewBox="0 0 10 10"
                ><path d="M2 3.5 5 6.5 8 3.5" /></svg>
              </button>
              <span
                v-else
                class="chevron-spacer"
              />
              <i
                class="status-dot"
                :class="group.leadStatus"
              />
              <span class="agent-copy">
                <b>{{ group.name }}</b>
                <small>{{ group.meta }}</small>
              </span>
            </div>
            <div class="working-column truncate">
              {{ group.workingOn }}
            </div>
            <div class="activity-cell truncate">
              {{ group.activity }}
            </div>
            <div class="checkin-cell muted">
              —
            </div>
            <div class="elapsed-cell">
              {{ formatDuration(group.startedAt) }}
            </div>
            <div class="row-actions">
              <button
                v-if="group.agent"
                class="small-button"
                type="button"
                @click="openAgent(group.agent)"
              >
                Open
              </button>
            </div>
          </div>

          <template v-if="!collapsedGroups.has(group.id)">
            <div
              v-for="(child, index) in group.children"
              :key="child.id"
              class="table-row child-row"
              :class="[rowClass(child.status), { last: index === group.children.length - 1 }]"
            >
              <div class="agent-cell child-agent">
                <i
                  class="status-dot"
                  :class="child.status"
                />
                <span class="agent-copy">
                  <b>{{ child.name }}</b>
                  <small>{{ child.meta }}</small>
                </span>
              </div>
              <div
                class="working-column truncate"
                :title="child.workingOn"
              >
                {{ child.workingOn }}
              </div>
              <div
                class="activity-cell truncate"
                :title="child.activity"
              >
                <span
                  v-if="child.status === 'waiting'"
                  class="activity-reason waiting-text"
                >Waiting</span>
                <span
                  v-else-if="child.status === 'problem'"
                  class="activity-reason problem-text"
                >{{ child.failed ? 'Failed' : 'Stuck' }}</span>
                {{ child.activity }}
              </div>
              <div class="checkin-cell">
                <template v-if="child.progress !== null">
                  <span
                    class="progress-track"
                    :class="child.status"
                  ><i :style="{ width: `${child.progress}%` }" /></span>
                  <span>{{ child.progress }}%</span>
                </template>
                <span
                  v-else
                  class="muted"
                >—</span>
              </div>
              <div class="elapsed-cell">
                {{ formatDuration(child.startedAt, child.finishedAt) }}
              </div>
              <div class="row-actions">
                <button
                  v-if="child.canOpen"
                  class="small-button"
                  type="button"
                  @click="openTask(child)"
                >
                  Open
                </button>
                <button
                  v-if="child.canMessage"
                  class="small-button"
                  type="button"
                  @click="messageTarget = child"
                >
                  Message
                </button>
                <button
                  v-if="child.canStop"
                  class="small-button danger-button"
                  type="button"
                  @click="stopTarget = child"
                >
                  Stop
                </button>
              </div>
            </div>
          </template>
        </article>

        <footer class="legend">
          <span><i class="status-dot running" />running</span>
          <span><i class="status-dot waiting" />waiting on a person</span>
          <span><i class="status-dot problem" />stuck / failed</span>
          <span><i class="status-dot idle" />idle</span>
          <span><i class="status-dot paused" />paused</span>
          <span><i class="status-dot workflow" />workflow run</span>
          <span class="legend-total">{{ visibleRowCount }} shown</span>
        </footer>
      </section>
    </main>

    <div
      v-if="messageTarget"
      class="modal-backdrop"
      @click.self="closeMessage"
    >
      <form
        class="action-modal"
        @submit.prevent="sendMessage"
      >
        <span class="modal-kicker">Message agent</span>
        <h2>{{ messageTarget.name }}</h2>
        <p>Send new direction to this running task. It’ll be delivered live or at the next model boundary.</p>
        <textarea
          v-model="messageText"
          autofocus
          rows="4"
          placeholder="What should this agent know?"
        />
        <p
          v-if="actionError"
          class="modal-error"
        >
          {{ actionError }}
        </p>
        <div class="modal-actions">
          <button
            class="small-button"
            type="button"
            @click="closeMessage"
          >
            Cancel
          </button>
          <button
            class="small-button primary-button"
            type="submit"
            :disabled="!messageText.trim() || actionBusy"
          >
            {{ actionBusy ? 'Sending…' : 'Send message' }}
          </button>
        </div>
      </form>
    </div>

    <div
      v-if="stopTarget"
      class="modal-backdrop"
      @click.self="closeStop"
    >
      <section class="action-modal">
        <span class="modal-kicker danger-copy">Stop job</span>
        <h2>Stop {{ stopTarget.name }}?</h2>
        <p>This uses the real cooperative kill switch. The current tool call may finish first, then the entire job{{ stopTarget.jobTaskCount > 1 ? ` and its ${stopTarget.jobTaskCount} tasks` : '' }} will unwind.</p>
        <p
          v-if="actionError"
          class="modal-error"
        >
          {{ actionError }}
        </p>
        <div class="modal-actions">
          <button
            class="small-button"
            type="button"
            @click="closeStop"
          >
            Cancel
          </button>
          <button
            class="small-button solid-danger"
            type="button"
            :disabled="actionBusy"
            @click="stopJob"
          >
            {{ actionBusy ? 'Stopping…' : 'Stop job' }}
          </button>
        </div>
      </section>
    </div>

    <div
      v-if="toast"
      class="toast"
      role="status"
    >
      {{ toast }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { useTheme } from '@pkg/composables/useTheme';
import type { AgentsListResponse } from '@pkg/main/agentsIpc';
import AgentConversations from '@pkg/pages/agents/AgentConversations.vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type Agent = AgentsListResponse['agents'][number];
type Job = AgentsListResponse['jobs'][number];
type JobTask = Job['tasks'][number];
type RowStatus = 'running' | 'waiting' | 'problem' | 'paused' | 'idle' | 'workflow';
type FilterKey = 'all' | 'running' | 'waiting' | 'problems' | 'paused';

interface ChildRow {
  id:              string;
  kind:            'task' | 'workflow';
  status:          RowStatus;
  failed:          boolean;
  name:            string;
  meta:            string;
  workingOn:       string;
  activity:        string;
  progress:        number | null;
  startedAt:       number;
  finishedAt?:     number;
  jobId?:          string;
  taskIndex?:      number;
  parentThreadId?: string;
  threadId?:       string;
  jobTaskCount:    number;
  canOpen:         boolean;
  canMessage:      boolean;
  canStop:         boolean;
}

interface AgentGroup {
  id:         string;
  name:       string;
  meta:       string;
  workingOn:  string;
  activity:   string;
  startedAt:  number;
  leadStatus: RowStatus;
  agent?:     Agent;
  children:   ChildRow[];
}

const POLL_MS = 3_000;
const STUCK_MS = 15 * 60_000;
const { isDark } = useTheme();

const data = ref<AgentsListResponse>({ agents: [], heartbeat: null, jobs: [], workflowRuns: [], updatedAt: 0 });
const loading = ref(true);
const polling = ref(true);
const pollTick = ref(0);
const now = ref(Date.now());
const tokenTotal = ref<number | null>(null);
const activeFilter = ref<FilterKey>('all');
const search = ref('');
const collapsedGroups = ref(new Set<string>());
const selectedAgent = ref<{ channel: string; name: string } | null>(null);
const messageTarget = ref<ChildRow | null>(null);
const stopTarget = ref<ChildRow | null>(null);
const messageText = ref('');
const actionBusy = ref(false);
const actionError = ref('');
const toast = ref('');
let pollTimer: ReturnType<typeof setInterval> | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function taskStatus(job: Job, task: JobTask): { status: RowStatus; failed: boolean } {
  const failed = job.status === 'failed' || task.status === 'error' || task.status === 'blocked';
  if (failed) return { status: 'problem', failed: true };
  if (task.waitingForHuman) return { status: 'waiting', failed: false };
  if (task.status === 'stopped') return { status: 'idle', failed: false };
  if (['running', 'queued'].includes(task.status)) {
    const checkinAt = task.latestCheckin?.createdAt ?? task.startedAt;
    if (now.value - checkinAt >= STUCK_MS) return { status: 'problem', failed: false };
    return { status: 'running', failed: false };
  }
  return { status: 'idle', failed: false };
}

function taskRow(job: Job, task: JobTask): ChildRow {
  const classification = taskStatus(job, task);
  const ageSource = task.latestCheckin?.createdAt ?? task.startedAt;
  let activity = task.latestCheckin?.summary || task.lastActivity || 'Working';
  if (classification.status === 'waiting') activity = task.latestCheckin?.summary || task.lastActivity || 'Needs a reply';
  if (classification.status === 'problem' && !classification.failed) activity = `no check-in for ${ formatAge(ageSource) }`;
  if (classification.failed) activity = task.latestCheckin?.blockers?.[0] || job.error || activity;
  return {
    id:             `${ job.jobId }:${ task.taskIndex }`,
    kind:           'task',
    status:         classification.status,
    failed:         classification.failed,
    name:           task.label || task.agentId,
    meta:           `${ task.model || task.agentId } · ${ task.kind } · depth ${ task.depth }`,
    workingOn:      task.taskId || job.parentTitle || shortJobId(job.jobId),
    activity,
    progress:       typeof task.latestCheckin?.percent === 'number' ? Math.max(0, Math.min(100, Math.round(task.latestCheckin.percent))) : null,
    startedAt:      task.startedAt,
    finishedAt:     task.finishedAt,
    jobId:          job.jobId,
    taskIndex:      task.taskIndex,
    parentThreadId: job.parentThreadId,
    threadId:       task.threadId,
    jobTaskCount:   job.taskCount,
    canOpen:        !!(job.parentThreadId && task.threadId),
    canMessage:     job.status === 'running' && ['queued', 'running'].includes(task.status),
    canStop:        job.status === 'running' && ['queued', 'running'].includes(task.status),
  };
}

const groups = computed<AgentGroup[]>(() => {
  const activeJobs = data.value.jobs.filter(job => !['completed', 'stopped'].includes(job.status));
  const grouped = new Map<string, Job[]>();
  for (const job of activeJobs) {
    const key = job.parentThreadId || job.parentChannel || `job:${ job.jobId }`;
    grouped.set(key, [...(grouped.get(key) || []), job]);
  }
  const result: AgentGroup[] = [];
  const claimedChannels = new Set<string>();
  for (const [key, jobs] of grouped) {
    const first = jobs[0];
    const agent = data.value.agents.find(item => item.channel === first.parentChannel || item.agentId === first.parentAgentId);
    if (agent) claimedChannels.add(agent.channel);
    const children = jobs.flatMap(job => job.tasks
      .filter(task => !['completed', 'stopped'].includes(task.status))
      .map(task => taskRow(job, task)));
    if (!children.length) continue;
    result.push({
      id:         `chat:${ key }`,
      name:       agent?.name || first.parentAgentId || first.parentChannel || 'Agent job',
      meta:       `chat lead · ${ children.length } sub-agent${ children.length === 1 ? '' : 's' }`,
      workingOn:  first.parentTitle || 'Active chat',
      activity:   agent?.statusNote || (children.some(child => child.status === 'waiting') ? 'Waiting on a person' : 'Coordinating sub-agents'),
      startedAt:  Math.min(agent?.startedAt ?? Infinity, ...jobs.map(job => job.createdAt)),
      leadStatus: agent?.status === 'idle' ? 'idle' : 'running',
      agent,
      children,
    });
  }

  for (const agent of data.value.agents.filter(item => item.type !== 'heartbeat' && !claimedChannels.has(item.channel))) {
    result.push({
      id:         `agent:${ agent.channel }`,
      name:       agent.name,
      meta:       `${ agent.role || agent.type } · ${ agent.channel }`,
      workingOn:  agent.statusNote || 'Available',
      activity:   agent.status === 'running' ? 'Active' : agent.status,
      startedAt:  agent.startedAt,
      leadStatus: agent.status === 'running' ? 'running' : 'idle',
      agent,
      children:   [],
    });
  }

  if (data.value.heartbeat) {
    const heartbeat = data.value.heartbeat;
    result.push({
      id:         'heartbeat',
      name:       'Heartbeat',
      meta:       'system agent · autonomous cycle',
      workingOn:  heartbeat.isExecuting ? 'Running a cycle' : heartbeat.schedulerRunning ? 'Watching the agenda' : 'Scheduler stopped',
      activity:   heartbeat.isExecuting ? 'Executing' : heartbeat.schedulerRunning ? `Last trigger ${ heartbeat.lastTriggerMs ? formatAge(heartbeat.lastTriggerMs) : 'not recorded' }` : 'Stopped',
      startedAt:  now.value - heartbeat.uptimeMs,
      leadStatus: heartbeat.isExecuting ? 'running' : 'idle',
      agent:      data.value.agents.find(item => item.type === 'heartbeat'),
      children:   [],
    });
  }

  if (data.value.workflowRuns.length) {
    result.push({
      id:         'workflows',
      name:       'Workflow runs',
      meta:       `${ data.value.workflowRuns.length } active or recent`,
      workingOn:  'Automated work',
      activity:   'Workflow manager',
      startedAt:  Math.min(...data.value.workflowRuns.map(run => run.startedAt)),
      leadStatus: 'workflow',
      children:   data.value.workflowRuns.map(run => ({
        id:           `workflow:${ run.executionId }`,
        kind:         'workflow',
        status:       run.status === 'failed' ? 'problem' : run.status === 'suspended' ? 'paused' : 'workflow',
        failed:       run.status === 'failed',
        name:         run.name,
        meta:         `workflow run · ${ run.slug }`,
        workingOn:    shortId(run.executionId),
        activity:     run.error || run.activity,
        progress:     typeof run.progress === 'number' ? Math.max(0, Math.min(100, Math.round(run.progress))) : null,
        startedAt:    run.startedAt,
        jobTaskCount: 0,
        canOpen:      false,
        canMessage:   false,
        canStop:      false,
      })),
    });
  }
  return result.sort((a, b) => a.startedAt - b.startedAt);
});

const allChildRows = computed(() => groups.value.flatMap(group => group.children));
const leadRunningCount = computed(() => groups.value.filter(group => group.leadStatus === 'running').length);
const subagentCount = computed(() => allChildRows.value.filter(row => row.kind === 'task').length);
const subagentRunningCount = computed(() => allChildRows.value.filter(row => row.kind === 'task' && row.status === 'running').length);
const runningCount = computed(() => leadRunningCount.value + subagentRunningCount.value);
const waitingCount = computed(() => allChildRows.value.filter(row => row.status === 'waiting').length);
const problemRows = computed(() => allChildRows.value.filter(row => row.status === 'problem'));
const problemCount = computed(() => problemRows.value.length);
const pausedCount = computed(() => allChildRows.value.filter(row => row.status === 'paused').length + groups.value.filter(group => group.leadStatus === 'paused').length);
const problemSummary = computed(() => {
  const failed = problemRows.value.filter(row => row.failed).length;
  const stuck = problemRows.value.length - failed;
  if (!failed && !stuck) return 'No stalled work';
  return [stuck ? `${ stuck } stuck` : '', failed ? `${ failed } failed` : ''].filter(Boolean).join(' · ');
});
const maxDepth = computed(() => Math.max(0, ...data.value.jobs.flatMap(job => job.tasks.map(task => task.depth))));
const depthLabel = computed(() => subagentCount.value ? `max depth ${ maxDepth.value }` : 'No delegated work');
const updatedAgo = computed(() => data.value.updatedAt ? formatAge(data.value.updatedAt) : 'just now');

const filterOptions = computed(() => [
  { key: 'all' as const, label: 'All', count: groups.value.length + allChildRows.value.length },
  { key: 'running' as const, label: 'Running', count: runningCount.value + allChildRows.value.filter(row => row.status === 'workflow').length },
  { key: 'waiting' as const, label: 'Waiting', count: waitingCount.value },
  { key: 'problems' as const, label: 'Problems', count: problemCount.value },
  { key: 'paused' as const, label: 'Paused', count: pausedCount.value },
]);

function matchesFilter(status: RowStatus): boolean {
  if (activeFilter.value === 'all') return true;
  if (activeFilter.value === 'running') return status === 'running' || status === 'workflow';
  if (activeFilter.value === 'waiting') return status === 'waiting';
  if (activeFilter.value === 'problems') return status === 'problem';
  return status === 'paused';
}

function matchesSearch(...values: (string | undefined)[]): boolean {
  if (!search.value) return true;
  const needle = search.value.toLowerCase();
  return values.some(value => value?.toLowerCase().includes(needle));
}

const filteredGroups = computed(() => groups.value.flatMap(group => {
  const groupMatches = matchesFilter(group.leadStatus) && matchesSearch(group.name, group.meta, group.workingOn, group.activity);
  const children = group.children.filter(child => matchesFilter(child.status) && matchesSearch(child.name, child.meta, child.workingOn, child.activity));
  if (!groupMatches && children.length === 0) return [];
  return [{ ...group, children: groupMatches && activeFilter.value === 'all' && !search.value ? group.children : children }];
}));

const visibleRowCount = computed(() => filteredGroups.value.reduce((count, group) => count + 1 + (collapsedGroups.value.has(group.id) ? 0 : group.children.length), 0));

async function loadAgents(): Promise<void> {
  pollTick.value += 1;
  if (selectedAgent.value) return;
  try {
    data.value = await ipcRenderer.invoke('agents:list');
    polling.value = true;
  } catch {
    polling.value = false;
  } finally {
    loading.value = false;
  }
}

async function loadUsage(): Promise<void> {
  try {
    const summary = await ipcRenderer.invoke('usage:summary', { hours: 24 });
    tokenTotal.value = summary.totals.totalTokens;
  } catch {
    tokenTotal.value = null;
  }
}

function openAgent(agent: Agent): void {
  selectedAgent.value = { channel: agent.channel, name: agent.name };
}

async function openTask(row: ChildRow): Promise<void> {
  if (!row.jobId || row.taskIndex === undefined || !row.parentThreadId) return;
  const opened = await ipcRenderer.invoke('agents:open-job-in-tab', row.jobId, row.parentThreadId, row.taskIndex);
  if (!opened) showToast('That agent could not be opened in a tab.');
}

async function sendMessage(): Promise<void> {
  const target = messageTarget.value;
  if (!target?.jobId || target.taskIndex === undefined || !messageText.value.trim()) return;
  actionBusy.value = true;
  actionError.value = '';
  const result = await ipcRenderer.invoke('agents:message-job', target.jobId, target.taskIndex, messageText.value.trim());
  actionBusy.value = false;
  if (!result.ok) {
    actionError.value = result.error || 'The message could not be delivered.';
    return;
  }
  closeMessage();
  showToast('Message sent.');
  loadAgents().catch(() => {});
}

async function stopJob(): Promise<void> {
  const target = stopTarget.value;
  if (!target?.jobId) return;
  actionBusy.value = true;
  actionError.value = '';
  const result = await ipcRenderer.invoke('agents:stop-job', target.jobId);
  actionBusy.value = false;
  if (!result.ok) {
    actionError.value = result.error || 'The job could not be stopped.';
    return;
  }
  closeStop();
  showToast('Stop requested.');
  loadAgents().catch(() => {});
}

function closeMessage(): void {
  messageTarget.value = null;
  messageText.value = '';
  actionError.value = '';
  actionBusy.value = false;
}
function closeStop(): void {
  stopTarget.value = null;
  actionError.value = '';
  actionBusy.value = false;
}
function showToast(message: string): void {
  toast.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = '' }, 3_000);
}
function toggleGroup(id: string): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedGroups.value = next;
}
function rowClass(status: RowStatus): string { return `is-${ status }` }
function shortJobId(value: string): string { return `job …${ value.slice(-6) }` }
function shortId(value: string): string { return value.length > 18 ? `${ value.slice(0, 9) }…${ value.slice(-6) }` : value }
function compactNumber(value: number): string { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value) }
function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((now.value - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${ seconds }s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${ minutes }m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${ hours }h ago`;
  return `${ Math.floor(hours / 24) }d ago`;
}
function formatDuration(startedAt: number, finishedAt?: number): string {
  if (!Number.isFinite(startedAt)) return '—';
  const seconds = Math.max(0, Math.floor(((finishedAt || now.value) - startedAt) / 1000));
  if (seconds < 60) return `${ seconds }s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${ minutes }m`;
  const hours = Math.floor(minutes / 60);
  return `${ hours }h ${ minutes % 60 }m`;
}

onMounted(() => {
  Promise.all([loadAgents(), loadUsage()]).catch(() => {});
  pollTimer = setInterval(loadAgents, POLL_MS);
  clockTimer = setInterval(() => { now.value = Date.now() }, 1_000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (clockTimer) clearInterval(clockTimer);
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<style scoped>
.agents-page {
  --live-paper: #f4f7fb; --live-paper-2: #eaf0f6; --live-card: rgba(255,255,255,.82); --live-card-solid: #fff;
  --live-text: #1a2332; --live-muted: #5b6778; --live-dim: #8a94a3; --live-line: rgba(26,35,50,.09); --live-line-strong: rgba(26,35,50,.14);
  --live-accent: #3a7fa0; --live-accent-strong: #2f6a86; --live-accent-soft: rgba(58,127,160,.1);
  --live-ok: #1f9d55; --live-ok-soft: rgba(31,157,85,.12); --live-warn: #d98a0a; --live-warn-soft: rgba(217,138,10,.13); --live-bad: #d9403a; --live-bad-soft: rgba(217,64,58,.11);
  min-height: 100%; height: 100%; overflow: auto; color: var(--live-text);
  background: radial-gradient(900px 500px at 15% -10%,rgba(58,127,160,.1),transparent 60%),radial-gradient(700px 400px at 100% 0%,rgba(58,127,160,.06),transparent 55%),var(--live-paper);
  font-family: var(--font-body,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif); font-size: 13px; line-height: 1.45; font-variant-numeric: tabular-nums;
}
.agents-page.dark {
  --live-paper: var(--bg,#0c1118); --live-paper-2: var(--surface-2,#17202c); --live-card: color-mix(in srgb,var(--surface-1,#121922) 88%,transparent); --live-card-solid: var(--surface-2,#17202c);
  --live-text: var(--text,#edf2f7); --live-muted: var(--text-muted,#a8b1bd); --live-dim: var(--text-dim,#74808e); --live-line: var(--border-muted,rgba(255,255,255,.08)); --live-line-strong: var(--border,rgba(255,255,255,.14));
  --live-accent: var(--accent,#5096b3); --live-accent-strong: var(--accent-hover,#68aac5); --live-accent-soft: var(--accent-dim,rgba(80,150,179,.14));
  background: radial-gradient(900px 500px at 15% -10%,rgba(80,150,179,.12),transparent 60%),var(--live-paper);
}
.conversation-view { min-height: 100%; }
.live-view { max-width: 1500px; margin: 0 auto; padding: 28px 30px 56px; }
.page-head { display: flex; align-items: flex-start; gap: 20px; margin-bottom: 20px; }
.page-head h1 { margin: 0 0 3px; font-size: 24px; line-height: 1.2; font-weight: 680; letter-spacing: -.02em; }
.page-head p { margin: 0; color: var(--live-muted); font-size: 12.5px; }
.stream-state { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; padding-top: 5px; color: var(--live-muted); font-size: 11.5px; white-space: nowrap; }
.stream-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--live-ok); box-shadow: 0 0 0 3px var(--live-ok-soft); animation: pulse 2s infinite; }
.stream-state.offline i { background: var(--live-bad); box-shadow: 0 0 0 3px var(--live-bad-soft); animation: none; }
@keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(31,157,85,.05); } }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(175px,1fr)); gap: 12px; margin-bottom: 18px; }
.summary-card { min-height: 105px; padding: 14px 16px 13px; border: 1px solid var(--live-line); border-radius: 12px; background: var(--live-card); box-shadow: 0 1px 2px rgba(26,35,50,.04),0 10px 30px -12px rgba(26,35,50,.12); backdrop-filter: blur(12px); }
.summary-label { display: flex; align-items: center; gap: 7px; color: var(--live-muted); font-size: 11.5px; font-weight: 550; }
.summary-card strong { display: block; margin: 7px 0 2px; font-size: 27px; line-height: 1.05; font-weight: 680; letter-spacing: -.03em; }
.summary-card > span { color: var(--live-dim); font-size: 11px; }
.summary-card.warning strong { color: var(--live-warn); } .summary-card.danger strong { color: var(--live-bad); }
.filters { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.segments { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--live-line-strong); border-radius: 9px; background: var(--live-card-solid); }
.segments button { padding: 5px 10px; border: 0; border-radius: 6px; color: var(--live-muted); background: transparent; font: 550 12px inherit; cursor: pointer; }
.segments button span { color: var(--live-dim); font-size: 10.5px; }
.segments button.active { color: var(--live-accent-strong); background: var(--live-accent-soft); font-weight: 650; }
.search-box { margin-left: auto; display: flex; align-items: center; gap: 7px; width: min(280px,35vw); padding: 6px 10px; border: 1px solid var(--live-line-strong); border-radius: 9px; background: var(--live-card-solid); color: var(--live-dim); }
.search-box svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; }
.search-box input { min-width: 0; width: 100%; border: 0; outline: 0; color: var(--live-text); background: transparent; font: 12.5px inherit; }
.search-box input::placeholder { color: var(--live-dim); }
.tree-card { overflow: hidden; border: 1px solid var(--live-line); border-radius: 12px; background: var(--live-card); box-shadow: 0 1px 2px rgba(26,35,50,.04),0 10px 30px -12px rgba(26,35,50,.12); backdrop-filter: blur(12px); }
.table-row { display: grid; grid-template-columns: minmax(210px,1.35fr) minmax(150px,1fr) minmax(180px,1.3fr) 105px 72px minmax(135px,auto); align-items: center; min-height: 49px; padding: 0 14px; border-bottom: 1px solid var(--live-line); gap: 12px; }
.table-head { min-height: 38px; color: var(--live-dim); background: color-mix(in srgb,var(--live-paper-2) 54%,transparent); font-size: 10.5px; font-weight: 650; letter-spacing: .055em; text-transform: uppercase; }
.actions-heading { text-align: right; } .agent-group:last-of-type .table-row:last-child { border-bottom: 0; }
.lead-row { min-height: 58px; background: color-mix(in srgb,var(--live-card-solid) 42%,transparent); }
.child-row:hover { background: color-mix(in srgb,var(--live-text) 2.5%,transparent); }
.table-row.is-problem { background: linear-gradient(90deg,var(--live-bad-soft),transparent 48%); }
.table-row.is-waiting { background: linear-gradient(90deg,var(--live-warn-soft),transparent 48%); }
.agent-cell { display: flex; align-items: center; gap: 9px; min-width: 0; }
.agent-copy { min-width: 0; } .agent-copy b,.agent-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-copy b { font-weight: 650; } .agent-copy small { color: var(--live-dim); font-size: 11px; }
.chevron { display: grid; width: 16px; height: 20px; place-items: center; padding: 0; border: 0; color: var(--live-dim); background: transparent; cursor: pointer; }
.chevron svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1.6; transition: transform .15s ease; }
.chevron svg.collapsed { transform: rotate(-90deg); } .chevron-spacer { width: 16px; }
.child-agent { position: relative; padding-left: 46px; }
.child-agent::before { content: ''; position: absolute; left: 27px; top: -25px; bottom: 50%; width: 11px; border-left: 1.5px solid var(--live-line-strong); border-bottom: 1.5px solid var(--live-line-strong); border-bottom-left-radius: 6px; }
.child-row:not(.last) .child-agent::after { content: ''; position: absolute; left: 27px; top: 50%; bottom: -25px; border-left: 1.5px solid var(--live-line-strong); }
.status-dot { display: inline-block; flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--live-dim); box-shadow: 0 0 0 3px color-mix(in srgb,var(--live-dim) 16%,transparent); }
.status-dot.running { background: var(--live-ok); box-shadow: 0 0 0 3px var(--live-ok-soft); } .status-dot.waiting { background: var(--live-warn); box-shadow: 0 0 0 3px var(--live-warn-soft); }
.status-dot.problem { background: var(--live-bad); box-shadow: 0 0 0 3px var(--live-bad-soft); } .status-dot.idle { background: var(--live-dim); }
.status-dot.paused { border: 2px solid var(--live-dim); background: transparent; } .status-dot.workflow { background: var(--live-accent); box-shadow: 0 0 0 3px var(--live-accent-soft); }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .working-column { color: var(--live-text); }
.activity-cell,.elapsed-cell,.checkin-cell { color: var(--live-muted); font-size: 12px; } .activity-reason { margin-right: 5px; font-weight: 650; }
.waiting-text { color: var(--live-warn); } .problem-text { color: var(--live-bad); } .checkin-cell { display: flex; align-items: center; gap: 6px; }
.progress-track { width: 44px; height: 4px; overflow: hidden; border-radius: 999px; background: var(--live-paper-2); }
.progress-track i { display: block; height: 100%; border-radius: inherit; background: var(--live-accent); } .progress-track.problem i { background: var(--live-bad); } .progress-track.waiting i { background: var(--live-warn); }
.muted { color: var(--live-dim); } .row-actions { display: flex; justify-content: flex-end; gap: 4px; }
.small-button { padding: 4px 8px; border: 1px solid var(--live-line-strong); border-radius: 7px; color: var(--live-text); background: var(--live-card-solid); box-shadow: 0 1px 1px rgba(26,35,50,.03); font: 550 11.5px inherit; white-space: nowrap; cursor: pointer; }
.small-button:hover { border-color: color-mix(in srgb,var(--live-accent) 45%,transparent); color: var(--live-accent-strong); } .small-button:disabled { opacity: .55; cursor: default; }
.danger-button,.danger-copy { color: var(--live-bad); } .primary-button { border-color: var(--live-accent); color: #fff; background: var(--live-accent); } .solid-danger { border-color: var(--live-bad); color: #fff; background: var(--live-bad); }
.legend { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; min-height: 42px; padding: 9px 16px; border-top: 1px solid var(--live-line); color: var(--live-dim); background: color-mix(in srgb,var(--live-text) 2%,transparent); font-size: 11.5px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; } .legend-total { margin-left: auto; } .empty-state { padding: 54px 20px; color: var(--live-muted); text-align: center; }
.modal-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 24px; background: rgba(6,10,16,.52); backdrop-filter: blur(5px); }
.action-modal { width: min(460px,100%); padding: 22px; border: 1px solid var(--live-line-strong); border-radius: 14px; color: var(--live-text); background: var(--live-card-solid); box-shadow: 0 24px 70px rgba(0,0,0,.24); }
.modal-kicker { color: var(--live-accent-strong); font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; } .action-modal h2 { margin: 7px 0 5px; font-size: 20px; }
.action-modal p { margin: 0 0 16px; color: var(--live-muted); font-size: 12.5px; } .action-modal textarea { width: 100%; resize: vertical; padding: 10px 11px; border: 1px solid var(--live-line-strong); border-radius: 9px; outline: 0; color: var(--live-text); background: var(--live-paper); font: 13px/1.45 inherit; }
.action-modal textarea:focus { border-color: var(--live-accent); box-shadow: 0 0 0 3px var(--live-accent-soft); } .action-modal .modal-error { margin: 10px 0 0; color: var(--live-bad); }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; } .toast { position: fixed; right: 24px; bottom: 24px; z-index: 60; padding: 9px 13px; border: 1px solid var(--live-line-strong); border-radius: 9px; color: var(--live-text); background: var(--live-card-solid); box-shadow: 0 10px 35px rgba(0,0,0,.18); }
@media (max-width: 1100px) { .table-row { grid-template-columns: minmax(210px,1.2fr) minmax(170px,1fr) 100px 70px minmax(128px,auto); } .working-column { display: none; } }
@media (max-width: 780px) { .live-view { padding: 22px 18px 46px; } .filters { align-items: stretch; flex-direction: column; } .segments { overflow-x: auto; } .search-box { margin-left: 0; width: 100%; } .table-row { grid-template-columns: minmax(185px,1fr) minmax(130px,1fr) 70px minmax(82px,auto); } .checkin-cell { display: none; } .row-actions { flex-wrap: wrap; } .legend-total { width: 100%; margin-left: 0; } }
</style>
