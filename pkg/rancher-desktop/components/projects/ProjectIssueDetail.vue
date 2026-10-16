<template>
  <main
    ref="detailRoot"
    class="issue-detail"
    tabindex="-1"
    aria-labelledby="issue-detail-title"
    @keydown.esc="$emit('close')"
  >
    <header class="issue-topbar">
      <button
        type="button"
        class="back"
        aria-label="Back to Projects"
        @click="$emit('close')"
      >
        ← Projects
      </button>
      <span class="crumbs">{{ projectTitle }} <span class="sep">›</span> {{ epicTitle }}</span>
      <button
        type="button"
        class="refresh"
        :disabled="loading"
        @click="onRefresh"
      >
        {{ loading ? 'Refreshing…' : '↻ Refresh' }}
      </button>
    </header>

    <div
      v-if="loading && !detail"
      class="issue-state"
      role="status"
    >
      Loading issue and live review state…
    </div>
    <div
      v-else-if="error"
      class="issue-state error"
      role="alert"
    >
      <b>Couldn't load this issue.</b>
      <p>{{ error }}</p>
      <button
        type="button"
        @click="$emit('refresh')"
      >
        Try again
      </button>
    </div>

    <div
      v-else-if="detail"
      class="issue-layout"
    >
      <article class="issue-main">
        <div class="issue-heading">
          <span class="num mono">#{{ shortTaskId }}</span>
          <h1
            id="issue-detail-title"
            contenteditable="true"
            spellcheck="false"
            @blur="onTitleBlur"
            @keydown.enter.prevent="($event.target as HTMLElement).blur()"
          >
            {{ detail.task.title }}
          </h1>
          <div
            v-if="fieldError"
            class="field-error"
            role="alert"
          >
            {{ fieldError }}
          </div>

          <dl class="props">
            <dt>Status</dt>
            <dd>
              <span
                class="status-dot"
                :style="{ background: currentLaneColor }"
              />
              <select
                :value="detail.task.status"
                :disabled="fieldBusy === 'status'"
                @change="onStatusChange"
              >
                <option
                  v-if="!laneOptions.length"
                  :value="detail.task.status"
                >
                  {{ statusLabel(detail.task.status) }}
                </option>
                <option
                  v-for="lane in laneOptions"
                  :key="lane.lane_key"
                  :value="lane.lane_key"
                >
                  {{ lane.display_name }}
                </option>
              </select>
            </dd>

            <dt>Assignee</dt>
            <dd>
              <select
                :value="detail.task.assignee ?? ''"
                :disabled="fieldBusy === 'assignee'"
                @change="onAssigneeChange"
              >
                <option value="">
                  Unassigned
                </option>
                <option
                  v-for="opt in assigneeOptions"
                  :key="opt.value"
                  :value="opt.value"
                >
                  {{ opt.label }}
                </option>
              </select>
            </dd>

            <dt>Labels</dt>
            <dd class="labels-cell">
              <span
                v-for="label in detail.task.labels || []"
                :key="label"
                class="lb"
              >
                {{ label }}
                <button
                  type="button"
                  class="lb-x"
                  :aria-label="`Remove label ${label}`"
                  @click="removeLabel(label)"
                >×</button>
              </span>
              <input
                v-model="labelDraft"
                class="lb-add"
                type="text"
                placeholder="Add label…"
                @keydown.enter.prevent="addLabel"
              >
            </dd>

            <dt>Due</dt>
            <dd>
              <input
                type="date"
                :value="dueYmd"
                :disabled="fieldBusy === 'due_at'"
                @change="onDueChange"
              >
            </dd>

            <dt>Linked</dt>
            <dd>
              <a
                v-if="primaryPull"
                class="val lnk"
                :href="primaryPull.url || undefined"
                target="_blank"
                rel="noopener noreferrer"
              >{{ primaryPull.repository }}#{{ primaryPull.number }}{{ primaryPull.state === 'merged' ? ' · merged' : '' }}</a>
              <span
                v-else
                class="empty"
              >No pull request linked.</span>
            </dd>

            <dt>Project</dt>
            <dd>{{ projectTitle }}</dd>
          </dl>
        </div>

        <section
          class="panel description-panel"
          aria-labelledby="primary-description-title"
        >
          <div class="section-title">
            <div>
              <span class="eyebrow">Primary record</span>
              <h2 id="primary-description-title">
                Description
              </h2>
            </div>
            <span class="immutable">Immutable</span>
          </div>
          <div
            class="rich-content"
            v-html="rich(detail.task.description)"
          />
        </section>

        <section class="panel agent-panel">
          <div class="section-title">
            <div><span class="eyebrow">Live status</span><h2>Agent</h2></div>
          </div>

          <div
            v-if="liveTask"
            class="agentbox"
          >
            <div class="top2">
              <span class="avatar lg ag">{{ initials(liveTask.task.agentId) }}</span>
              <div>
                <b>{{ liveTask.task.agentId }} is working on this</b>
                <small>Started {{ formatAge(liveTask.task.startedAt) }} ago{{ liveTask.task.model ? ` · ${liveTask.task.model}` : '' }}</small>
              </div>
              <div class="r">
                <button
                  type="button"
                  class="btn sm"
                  :disabled="!canOpenChat"
                  @click="openChat"
                >
                  Open chat
                </button>
                <button
                  type="button"
                  class="btn sm danger"
                  :disabled="!canStop || stopping"
                  @click="confirmStop"
                >
                  {{ confirmingStop ? 'Confirm stop?' : 'Stop' }}
                </button>
              </div>
            </div>
            <div class="now">
              <div><span>Doing now</span><b>{{ liveTask.task.label || liveTask.task.latestCheckin?.summary || 'Working' }}</b></div>
              <div><span>Last check-in</span><b>{{ liveTask.task.latestCheckin ? formatAge(liveTask.task.latestCheckin.createdAt) + ' ago' : '—' }}</b></div>
            </div>
            <div
              v-if="liveTask.task.latestCheckin"
              class="ci"
            >
              <small>Last check-in · {{ formatAge(liveTask.task.latestCheckin.createdAt) }} ago</small>
              {{ liveTask.task.latestCheckin.summary }}
            </div>
            <div
              v-if="typeof liveTask.task.latestCheckin?.percent === 'number'"
              class="pbar"
            >
              <i :style="{ width: `${Math.max(0, Math.min(100, liveTask.task.latestCheckin.percent))}%` }" />
            </div>
            <p
              v-if="actionError"
              class="inline-error"
            >
              {{ actionError }}
            </p>
          </div>
          <p
            v-else
            class="empty"
          >
            No agent is currently working on this issue.
          </p>
        </section>

        <section
          class="panel thread"
          aria-labelledby="comment-thread-title"
        >
          <div class="section-title">
            <div>
              <span class="eyebrow">Activity</span>
              <h2 id="comment-thread-title">
                Activity &amp; comments · {{ feed.length }}
              </h2>
            </div>
          </div>
          <ol
            v-if="feed.length"
            class="feed-list"
          >
            <li
              v-for="item in feed"
              :key="item.key"
              class="feed-item"
              :class="{ 'is-comment': item.kind === 'comment' }"
            >
              <template v-if="item.kind === 'comment'">
                <div class="comment-meta">
                  <b>{{ actorLabel(item.author) }}</b>
                  <time :datetime="item.at">{{ shortDate(item.at) }}</time>
                </div>
                <div
                  class="rich-content compact"
                  v-html="rich(item.body)"
                />
              </template>
              <template v-else>
                <span class="ev-dot" />
                <span class="ev-text">
                  <b>{{ actorLabel(item.author) }}</b> {{ item.label }}
                  <time :datetime="item.at">{{ shortDate(item.at) }}</time>
                </span>
              </template>
            </li>
          </ol>
          <p
            v-else
            class="empty"
          >
            No activity yet.
          </p>
          <form
            class="comment-form"
            @submit.prevent="submitComment"
          >
            <label for="issue-comment">Add to the thread</label>
            <textarea
              id="issue-comment"
              v-model="commentDraft"
              rows="4"
              placeholder="Add context or evidence…"
            />
            <div class="form-actions">
              <button
                type="submit"
                :disabled="busy || !commentDraft.trim()"
              >
                Append comment
              </button>
            </div>
          </form>
        </section>
      </article>

      <aside
        class="review-column"
        aria-label="Review brief"
      >
        <section class="panel review-brief">
          <div class="section-title">
            <div><span class="eyebrow">Canonical evidence</span><h2>Review brief</h2></div>
          </div>
          <p
            v-if="!detail.review.pullRequests.length"
            class="empty"
          >
            No pull request is linked to this issue.
          </p>
          <article
            v-for="pull in detail.review.pullRequests"
            :key="`${pull.repository}#${pull.number}`"
            class="pull-card"
          >
            <div class="pull-head">
              <div><b>{{ pull.repository }} #{{ pull.number }}</b><span>{{ pull.title || 'Pull request unavailable' }}</span></div>
              <span
                class="readiness"
                :class="{ ready: pull.mergeReady }"
              >{{ pull.mergeReady ? 'Ready' : 'Not ready' }}</span>
            </div>
            <p
              v-if="pull.error"
              class="inline-error"
            >
              {{ pull.error }}
            </p>
            <dl v-else>
              <div><dt>GitHub</dt><dd>{{ pull.state }}{{ pull.draft ? ' · draft' : '' }}</dd></div>
              <div><dt>Head</dt><dd><code>{{ pull.headSha }}</code></dd></div>
              <div><dt>Branch</dt><dd>{{ pull.headRef }} → {{ pull.baseRef }}</dd></div>
              <div><dt>Mergeable</dt><dd>{{ pull.mergeable === null ? 'unknown' : pull.mergeable ? pull.mergeableState : 'no' }}</dd></div>
            </dl>
            <div
              v-if="pull.checks.length"
              class="evidence-block"
            >
              <h3>Checks</h3>
              <div
                v-for="check in pull.checks"
                :key="check.name"
                class="evidence-row"
              >
                <span>{{ check.name }}</span><b>{{ check.conclusion || check.status }}</b>
              </div>
            </div>
            <p
              v-else-if="!pull.error"
              class="empty small"
            >
              No hosted checks found.
            </p>
            <div
              v-if="pull.reviews.length"
              class="evidence-block"
            >
              <h3>Reviews</h3>
              <div
                v-for="review in pull.reviews"
                :key="`${review.author}-${review.submittedAt}`"
                class="evidence-row"
              >
                <span>{{ review.author }}</span><b>{{ review.state }}</b>
              </div>
            </div>
            <a
              v-if="pull.url"
              :href="pull.url"
              target="_blank"
              rel="noopener noreferrer"
            >Open on GitHub ↗</a>
          </article>

          <EvidenceNotes
            title="Review evidence"
            :items="detail.review.reviewEvidence"
          />
          <EvidenceNotes
            title="Documentation"
            :items="detail.review.documentation"
            empty-label="No documentation notes recorded."
          />
          <EvidenceNotes
            title="Test results"
            :items="detail.review.testResults"
            empty-label="No test results recorded."
          />
          <EvidenceNotes
            title="Risk"
            :items="detail.review.riskNotes"
            empty-label="No explicit risk evidence recorded."
          />
          <EvidenceNotes
            title="Staging"
            :items="detail.review.stagingEvidence"
            empty-label="No staging evidence recorded."
          />
          <EvidenceNotes
            title="Rollback"
            :items="detail.review.rollbackNotes"
            empty-label="No rollback notes recorded."
          />
        </section>
      </aside>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import type { WorkCommentRecord } from '@pkg/agent/database/models/WorkItemsModel';
import type { EffectiveWorkLane } from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import type { ProjectsIssueDetail } from '@pkg/agent/services/ProjectsIssueDetailService';
import { formatDateOnly } from '@pkg/agent/utils/formatDateOnly';
import EvidenceNotes from '@pkg/components/projects/ProjectIssueEvidenceNotes.vue';
import type { AgentsListResponse } from '@pkg/main/agentsIpc';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { renderProjectRichText } from '@pkg/utils/projectRichText';

const props = defineProps<{
  taskId:       string;
  detail:       ProjectsIssueDetail | null;
  projectTitle: string;
  epicTitle:    string;
  loading:      boolean;
  busy:         boolean;
  error:        string;
  statusLabel:  (status: string) => string;
}>();

const emit = defineEmits<{
  close:   [];
  refresh: [];
  comment: [body: string];
}>();

const AGENT_POLL_MS = 5_000;

const detailRoot = ref<HTMLElement | null>(null);
const commentDraft = ref('');
const labelDraft = ref('');
const fieldBusy = ref<string | null>(null);
const fieldError = ref('');
const laneOptions = ref<EffectiveWorkLane[]>([]);
const assigneeOptions = ref<{ value: string; label: string }[]>([]);
const activity = ref<Awaited<ReturnType<typeof loadActivity>>>([]);
const agentsList = ref<AgentsListResponse | null>(null);
const confirmingStop = ref(false);
const stopping = ref(false);
const actionError = ref('');
let agentPollTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  detailRoot.value?.focus();
  loadAuxData();
  pollAgents();
  agentPollTimer = setInterval(pollAgents, AGENT_POLL_MS);
});

onBeforeUnmount(() => {
  if (agentPollTimer) clearInterval(agentPollTimer);
});

const shortTaskId = computed(() => props.taskId.slice(0, 8));

const currentLaneColor = computed(() => {
  const lane = laneOptions.value.find(l => l.lane_key === props.detail?.task.status);
  if (!lane) return 'var(--pacc)';
  return lane.color || (lane.semantic_role === 'blocked' ? 'var(--pamber)' : lane.semantic_role === 'terminal' ? 'var(--ptext3)' : 'var(--pacc)');
});

const dueYmd = computed(() => formatDateOnly(props.detail?.task.due_at ?? null));

const primaryPull = computed(() => props.detail?.review.pullRequests[0] ?? null);

interface FeedItem {
  key:    string;
  kind:   'comment' | 'event';
  author: string | null;
  at:     string;
  body:   string;
  label:  string;
}

const EVENT_LABELS: Record<string, string> = {
  task_created: 'created this issue',
  task_updated: 'updated this issue',
  task_moved:   'moved this issue',
};

const feed = computed<FeedItem[]>(() => {
  const comments: FeedItem[] = (props.detail?.comments ?? []).map(comment => ({
    key: `comment:${ comment.id }`, kind: 'comment', author: comment.author, at: comment.created_at, body: comment.body, label: '',
  }));
  const events: FeedItem[] = activity.value
    .filter(row => row.task_id === props.taskId && row.kind !== 'comment')
    .map(row => ({
      key: `event:${ row.id }`, kind: 'event', author: row.author, at: row.activity_at, body: '', label: EVENT_LABELS[row.kind] ?? row.kind,
    }));

  return [...comments, ...events].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
});

interface LiveAgentMatch {
  jobId:           string;
  jobStatus:       string;
  parentThreadId?: string;
  task: {
    taskIndex:     number;
    agentId:       string;
    label:         string;
    status:        string;
    threadId?:     string;
    startedAt:     number;
    model?:        string;
    latestCheckin: { summary: string; createdAt: number; percent?: number } | null;
  };
}

const liveTask = computed<LiveAgentMatch | null>(() => {
  for (const job of agentsList.value?.jobs ?? []) {
    const task = job.tasks.find(t => t.taskId === props.taskId && !['completed', 'stopped'].includes(t.status));
    if (task) {
      return {
        jobId: job.jobId, jobStatus: job.status, parentThreadId: job.parentThreadId, task,
      };
    }
  }
  return null;
});

const canOpenChat = computed(() => !!(liveTask.value?.parentThreadId && liveTask.value.task.threadId));
const canStop = computed(() => liveTask.value?.jobStatus === 'running' && ['queued', 'running'].includes(liveTask.value.task.status));

async function loadActivity() {
  if (!props.detail) return [];
  try {
    return await ipcRenderer.invoke('work-items:activity', { projectId: props.detail.task.project_id, limit: 300 });
  } catch {
    return [];
  }
}

async function loadAuxData(): Promise<void> {
  if (!props.detail) return;
  const [lanes, agentDefs, activityRows] = await Promise.all([
    ipcRenderer.invoke('work-items:lanes-resolve', props.detail.task.project_id, false).catch(() => []),
    ipcRenderer.invoke('agent-definitions:list').catch(() => []),
    loadActivity(),
  ]);
  laneOptions.value = (lanes as EffectiveWorkLane[]).filter(lane => lane.enabled && !lane.archived).sort((a, b) => a.position - b.position);
  assigneeOptions.value = [
    { value: 'heartbeat', label: 'Heartbeat (autonomous)' },
    { value: 'sulla', label: 'Sulla' },
    { value: 'human', label: 'Human' },
    ...(agentDefs as { slug: string; name: string; enabled: boolean }[])
      .filter(agent => agent.enabled)
      .map(agent => ({ value: agent.slug, label: agent.name || agent.slug })),
  ];
  activity.value = activityRows;
}

async function pollAgents(): Promise<void> {
  try {
    agentsList.value = await ipcRenderer.invoke('agents:list');
  } catch {
    // leave the previous snapshot in place; the next poll tries again
  }
}

function onRefresh(): void {
  emit('refresh');
  loadActivity().then(rows => { activity.value = rows });
}

async function saveField(changes: Record<string, unknown>, fieldKey: string): Promise<void> {
  if (!props.detail) return;
  fieldBusy.value = fieldKey;
  fieldError.value = '';
  try {
    await ipcRenderer.invoke('work-items:task-update', props.detail.task.id, { ...changes, actor: 'human' });
    emit('refresh');
  } catch (err: any) {
    fieldError.value = err?.message ?? String(err);
  } finally {
    fieldBusy.value = null;
  }
}

function onTitleBlur(event: FocusEvent): void {
  const title = (event.target as HTMLElement).innerText.trim();
  if (!title || title === props.detail?.task.title) return;
  saveField({ title }, 'title');
}

function onStatusChange(event: Event): void {
  saveField({ status: (event.target as HTMLSelectElement).value }, 'status');
}

function onAssigneeChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  saveField({ assignee: value || null }, 'assignee');
}

function onDueChange(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  saveField({ due_at: value ? new Date(`${ value }T00:00:00`).toISOString() : null }, 'due_at');
}

function addLabel(): void {
  const label = labelDraft.value.trim();
  if (!label || !props.detail) return;
  const existing = props.detail.task.labels || [];
  if (existing.includes(label)) { labelDraft.value = ''; return }
  labelDraft.value = '';
  saveField({ labels: [...existing, label] }, 'labels');
}

function removeLabel(label: string): void {
  if (!props.detail) return;
  saveField({ labels: (props.detail.task.labels || []).filter(l => l !== label) }, 'labels');
}

async function openChat(): Promise<void> {
  const match = liveTask.value;
  if (!match?.jobId || !match.parentThreadId) return;
  await ipcRenderer.invoke('agents:open-job-in-tab', match.jobId, match.parentThreadId, match.task.taskIndex);
}

function confirmStop(): void {
  if (!confirmingStop.value) {
    confirmingStop.value = true;
    setTimeout(() => { confirmingStop.value = false }, 4000);
    return;
  }
  confirmingStop.value = false;
  stopAgent();
}

async function stopAgent(): Promise<void> {
  const match = liveTask.value;
  if (!match?.jobId) return;
  stopping.value = true;
  actionError.value = '';
  try {
    const result = await ipcRenderer.invoke('agents:stop-job', match.jobId);
    if (result?.error) actionError.value = result.error;
    await pollAgents();
  } catch (err: any) {
    actionError.value = err?.message ?? String(err);
  } finally {
    stopping.value = false;
  }
}

function rich(value: string): string { return renderProjectRichText(value) }
function shortDate(iso: string): string { return new Date(iso).toLocaleString() }
function actorLabel(author: WorkCommentRecord['author']): string {
  if (author === 'human') return 'You';
  return author || 'Agent';
}
function initials(value: string): string { return value.slice(0, 2).toUpperCase() }
function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${ seconds }s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${ minutes }m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${ hours }h`;
  return `${ Math.round(hours / 24) }d`;
}
function submitComment(): void {
  const body = commentDraft.value.trim();
  if (!body || props.busy) return;
  emit('comment', body);
  commentDraft.value = '';
}
</script>

<style scoped lang="scss">
.issue-detail { position: absolute; inset: 0; z-index: 30; overflow: auto; background: var(--pbg); color: var(--ptext); outline: none; }
.issue-topbar { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; min-height: 58px; padding: 0 28px; border-bottom: 1px solid var(--pborder); background: color-mix(in srgb, var(--pbg) 94%, transparent); backdrop-filter: blur(18px); }
button { border: 1px solid var(--pacc-line); border-radius: 8px; padding: 8px 12px; background: var(--pacc-soft); color: var(--ptext); cursor: pointer; font: 600 12px var(--psans); }
button:focus-visible, a:focus-visible, textarea:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--pacc); outline-offset: 2px; }
button:disabled { opacity: .45; cursor: default; }
.back { justify-self: start; background: transparent; border-color: var(--pborder); }
.refresh { justify-self: end; background: transparent; border-color: var(--pborder); }
.crumbs, .eyebrow { color: var(--ptext3); font: 10px var(--pmono); letter-spacing: .12em; text-transform: uppercase; text-align: center; }
.crumbs .sep { opacity: .6; margin: 0 4px; }
.issue-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 430px); gap: 28px; width: min(1500px, 100%); margin: 0 auto; padding: 38px; }
.issue-main, .review-column { min-width: 0; }
.review-column { display: flex; flex-direction: column; gap: 18px; }
.issue-heading { margin: 0 0 28px; }
.num { color: var(--ptext3); font-size: 11px; letter-spacing: .08em; }
h1 { max-width: 980px; margin: 6px 0 20px; font: 500 clamp(26px, 3.4vw, 42px)/1.12 var(--pserif); border-radius: 8px; padding: 2px 4px; margin-left: -4px; }
h1:focus-visible { outline: 2px solid var(--pacc); outline-offset: 2px; }
h2 { margin: 4px 0 0; font: 500 22px var(--pserif); }
h3 { margin: 0 0 8px; font: 600 11px var(--pmono); letter-spacing: .08em; text-transform: uppercase; color: var(--ptext3); }
.field-error, .inline-error, .issue-state.error { color: var(--pred); font-size: 12px; margin: -4px 0 14px; }
.panel { border: 1px solid var(--pborder); border-radius: 14px; background: var(--psurface); padding: 24px; margin-bottom: 20px; }
.section-title, .pull-head, .evidence-row, .form-actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.immutable { color: var(--pacc); border: 1px solid var(--pacc-line); border-radius: 999px; padding: 4px 9px; font: 10px var(--pmono); }
.rich-content { margin-top: 22px; color: var(--ptext2); font-size: 14px; line-height: 1.72; overflow-wrap: anywhere; }
.rich-content.compact { margin-top: 8px; }
.rich-content :deep(h1), .rich-content :deep(h2), .rich-content :deep(h3) { color: var(--ptext); font-family: var(--pserif); }
.rich-content :deep(a) { color: var(--pacc); }
.rich-content :deep(pre) { overflow: auto; padding: 12px; border: 1px solid var(--pborder); border-radius: 8px; background: var(--pbg); white-space: pre-wrap; }
.rich-content :deep(code) { font-family: var(--pmono); }
.rich-content :deep(table) { width: 100%; border-collapse: collapse; }
.rich-content :deep(td), .rich-content :deep(th) { padding: 7px; border: 1px solid var(--pborder); text-align: left; }

/* props grid */
.props { display: grid; grid-template-columns: 90px 1fr; gap: 10px 12px; align-items: center; font-size: 12.5px; margin: 0; }
.props dt { color: var(--ptext3); font-weight: 500; margin: 0; }
.props dd { margin: 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 26px; }
.props select, .props input[type="date"] { border: 1px solid var(--pborder); border-radius: 7px; padding: 5px 8px; background: var(--psurface2); color: var(--ptext); font: inherit; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.empty { color: var(--ptext3); font-size: 12px; }
.empty.small { margin: 12px 0; }
.val.lnk { color: var(--pacc); font-weight: 500; }
.lb { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 9px; border-radius: 999px; background: var(--pacc-soft); color: var(--ptext2); font-size: 11px; font-weight: 600; }
.lb-x { border: 0; background: transparent; padding: 0 5px; margin: 0; color: var(--ptext3); font-size: 13px; border-radius: 50%; }
.lb-x:hover { color: var(--pred); background: transparent; }
.lb-add { border: 1px dashed var(--pborder); border-radius: 999px; padding: 3px 10px; background: transparent; color: var(--ptext); font-size: 11px; min-width: 90px; }

.feed-list { list-style: none; margin: 22px 0 0; padding: 0; }
.comment-meta { display: flex; justify-content: space-between; gap: 14px; color: var(--ptext3); font: 10px var(--pmono); }
.comment-meta b { color: var(--pacc); }
.feed-item { padding: 12px 0; border-top: 1px solid var(--pborder-soft); font-size: 12.5px; }
.feed-item:first-child { border-top: 0; }
.feed-item.is-comment { padding: 18px 0; }
.ev-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--ptext3); margin-right: 8px; vertical-align: middle; }
.ev-text { color: var(--ptext2); }
.ev-text b { color: var(--ptext); }
.ev-text time, .comment-meta time { color: var(--ptext3); font-size: 11px; margin-left: 6px; }
.comment-form { display: grid; gap: 8px; margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--pborder); }
label { color: var(--ptext3); font: 10px var(--pmono); letter-spacing: .08em; text-transform: uppercase; }
textarea { width: 100%; resize: vertical; border: 1px solid var(--pborder); border-radius: 8px; padding: 11px; background: var(--psurface2); color: var(--ptext); font: 13px/1.5 var(--psans); }

/* agent box */
.agentbox { border: 1px solid var(--pacc-line); background: var(--pacc-soft); border-radius: 12px; padding: 14px 16px; }
.agentbox .top2 { display: flex; align-items: center; gap: 10px; }
.agentbox .top2 b { display: block; font-size: 13px; }
.agentbox .top2 small { display: block; color: var(--ptext2); font-size: 11.5px; margin-top: 1px; }
.agentbox .top2 .r { margin-left: auto; display: flex; gap: 6px; }
.avatar { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 50%; background: var(--pacc); color: #fff; font-size: 11px; font-weight: 700; flex: none; }
.avatar.lg { width: 34px; height: 34px; }
.avatar.ag { border-radius: 8px; }
.now { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; font-size: 12px; }
.now div { display: flex; flex-direction: column; gap: 2px; }
.now span { color: var(--ptext3); font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; font-weight: 600; }
.now b { font-weight: 500; }
.ci { margin-top: 10px; padding: 9px 11px; border-radius: 8px; background: var(--psurface2); border: 1px solid var(--pborder); font-size: 12.5px; line-height: 1.45; }
.ci small { display: block; color: var(--ptext3); font-size: 11px; margin-bottom: 2px; }
.pbar { height: 5px; border-radius: 3px; background: var(--pborder-soft); margin-top: 10px; overflow: hidden; }
.pbar i { display: block; height: 100%; background: var(--pacc); border-radius: 3px; }
.btn { border: 1px solid var(--pborder); border-radius: 8px; padding: 6px 11px; background: var(--psurface2); color: var(--ptext); font: 600 11.5px var(--psans); }
.btn.sm { padding: 4px 9px; font-size: 11px; }
.btn.danger { color: var(--pred); border-color: color-mix(in srgb, var(--pred) 45%, transparent); background: transparent; }

.pull-card { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--pborder); }
.pull-head > div { display: grid; gap: 4px; min-width: 0; }
.pull-head span { color: var(--ptext2); font-size: 12px; }
.readiness { border: 1px solid var(--pborder); border-radius: 999px; padding: 4px 9px; color: var(--ptext2); font: 10px var(--pmono); }
.readiness.ready { color: var(--pgreen); border-color: var(--pgreen); }
dl { display: grid; gap: 8px; margin: 16px 0; }
dl div { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; }
dt { color: var(--ptext3); font: 10px var(--pmono); text-transform: uppercase; }
dd { min-width: 0; margin: 0; color: var(--ptext2); font-size: 12px; overflow-wrap: anywhere; }
dd code { font-size: 10px; }
.evidence-block { margin-top: 16px; }
.evidence-row { padding: 6px 0; border-top: 1px solid var(--pborder-soft); color: var(--ptext2); font-size: 11px; }
.evidence-row b { color: var(--ptext); font-family: var(--pmono); }
a { display: inline-block; margin-top: 14px; color: var(--pacc); font-size: 12px; }
.issue-state { display: grid; place-content: center; min-height: 60vh; gap: 8px; text-align: center; }
@media (max-width: 960px) { .issue-layout { grid-template-columns: 1fr; padding: 24px; } }

.theme-noir .issue-detail {
  inset: 0 0 0 auto;
  width: min(1240px, calc(100% - 70px));
  border-left: 1px solid color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent);
  background: color-mix(in srgb, var(--nx-surface) 96%, transparent);
  box-shadow: -36px 0 100px rgba(0,0,0,.62),-1px 0 0 color-mix(in srgb, var(--nx-accent-2) 8%, transparent);
  backdrop-filter: blur(26px) saturate(120%);
  animation: noir-issue-drawer-in .58s var(--noir-spring) both;
}
.theme-noir .issue-topbar { min-height: 64px; border-color: var(--nx-hair); background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .72); }
.theme-noir .issue-topbar button,
.theme-noir .issue-detail button { border-color: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent); border-radius: 999px; transition: transform .45s var(--noir-spring),background .16s ease,border-color .16s ease,box-shadow .16s ease; }
.theme-noir .issue-detail button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--nx-accent-2) 35%, transparent); background: color-mix(in srgb, var(--nx-accent) 10%, transparent); transform: translateY(-1px); }
.theme-noir .crumbs,
.theme-noir .eyebrow { color: var(--nx-accent-2); }
.theme-noir .issue-layout { gap: 24px; padding: 34px; }
.theme-noir h1 { color: var(--nx-read-1); font-weight: 600; letter-spacing: -.025em; }
.theme-noir h2 { color: var(--nx-read-2); }
.theme-noir .immutable,
.theme-noir .readiness,
.theme-noir .lb { border-color: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent); background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent); }
.theme-noir .panel {
  border-color: var(--nx-hair);
  border-radius: 18px;
  background: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 3.5%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 2.5%, transparent);
}
.theme-noir .review-brief { background: linear-gradient(160deg,color-mix(in srgb, var(--nx-accent) 7.5%, transparent),color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 2%, transparent)); }
.theme-noir .feed-item.is-comment {
  margin-top: 10px;
  padding: 14px 15px;
  border: 1px solid color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 7%, transparent);
  border-radius: 14px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .42);
}
.theme-noir textarea,
.theme-noir select,
.theme-noir input[type="date"] { border-color: color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 10%, transparent); border-radius: 12px; background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .7); }
.theme-noir .pull-card { padding: 16px; border: 1px solid var(--nx-hair); border-radius: 15px; background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .45); }
@keyframes noir-issue-drawer-in { from { opacity: 0; transform: translateX(52px); filter: blur(6px); } to { opacity: 1; transform: none; filter: none; } }
@media (max-width: 960px) { .theme-noir .issue-detail { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .theme-noir .issue-detail, .theme-noir .issue-detail button { animation: none; transition: none; } }

/* Noir Light softens dark-only elevation shadows for paper surfaces. */
.theme-noir-light .issue-detail {
  box-shadow: -36px 0 100px color-mix(in srgb, var(--nx-ink) 14%, transparent),-1px 0 0 color-mix(in srgb, var(--nx-accent-2) 8%, transparent);
}
</style>
