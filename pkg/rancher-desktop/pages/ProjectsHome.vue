<!--
  ProjectsHome — the Projects project state (issue ledger).

  Reads AND writes the Postgres work tables (work_projects → work_epics →
  work_tasks → work_task_comments) through the useProjects composable /
  work-items:* IPC bridge. Full CRUD: create/edit/archive projects, epics and
  tasks, edit every value, and comment on issues.

  Layout: pick a project on the left, its epics and issues render on the right.
  Today = epics-as-sections list; Board = the four status columns; Projects =
  the all-projects overview. Clicking an issue opens the detail drawer.
-->
<template>
  <div class="projects-home">
    <div class="ph-body">
      <!-- project list -->
      <aside class="ph-side">
        <div class="ph-side-h">
          <div class="ph-eyebrow">Outcome ledger</div>
          <h1>Projects</h1>
        </div>
        <div class="ph-list">
          <template v-for="group in groups" :key="group.label">
            <div v-if="group.items.length" class="ph-grp">{{ group.label }}</div>
            <button
              v-for="p in group.items"
              :key="p.id"
              type="button"
              class="ph-p"
              :class="{ on: p.id === selectedId }"
              @click="select(p.id)"
            >
              <span class="ph-pn"><span class="ph-st" :class="dotClass(p)" />{{ shortName(p) }}</span>
              <span class="ph-pc">{{ p.status === 'done' ? 'Closed' : `${ p.openCount } open · ${ p.doneCount } done` }}</span>
            </button>
          </template>
        </div>
        <div class="ph-side-f">
          <button type="button" class="ph-btn block" @click="openNewProject">＋ New project</button>
        </div>
      </aside>

      <!-- main -->
      <section class="ph-main">
        <div class="ph-top">
          <div class="ph-tabs">
            <button type="button" class="ph-tab" :class="{ on: tab === 'today' }" @click="tab = 'today'">Today</button>
            <button type="button" class="ph-tab" :class="{ on: tab === 'board' }" @click="tab = 'board'">Board</button>
            <button type="button" class="ph-tab" :class="{ on: tab === 'activity' }" @click="tab = 'activity'">Activity</button>
            <button type="button" class="ph-tab" :class="{ on: tab === 'projects' }" @click="tab = 'projects'">Projects</button>
            <button type="button" class="ph-tab" :class="{ on: tab === 'lanes' }" @click="tab = 'lanes'">Lanes</button>
          </div>
          <div class="ph-sp" />
          <button type="button" class="ph-btn ghost" @click="refresh" :disabled="isLoading">
            {{ isLoading ? 'Loading…' : '↻ Refresh' }}
          </button>
        </div>

        <div class="ph-canvas">
          <!-- states -->
          <div v-if="error" class="ph-state ph-err">
            <b>Couldn't load Projects.</b>
            <p>{{ error }}</p>
            <button type="button" class="ph-btn" @click="refresh">Try again</button>
          </div>
          <div v-else-if="isLoading && !loaded" class="ph-state">Loading the ledger…</div>
          <div v-else-if="!projects.length" class="ph-state">
            No projects yet. <button type="button" class="ph-btn" @click="openNewProject">Create the first one</button>
          </div>

          <template v-else>
            <div v-if="laneCapability && !laneCapability.ready" class="ph-state ph-err">
              <b>Lane automation is in compatibility mode.</b>
              <p>{{ laneCapability.degradedReason }}</p>
            </div>
            <!-- TODAY -->
            <div v-show="tab === 'today'" v-if="sel">
              <div class="ph-lead">
                <div class="ph-lead-row">
                  <h2>{{ shortName(sel) }}</h2>
                  <div class="ph-actions">
                    <button type="button" class="ph-btn ghost sm" @click="openEditProject(sel)">Edit</button>
                    <button type="button" class="ph-btn ghost sm" @click="openNewEpic(sel.id)">＋ Epic</button>
                    <button type="button" class="ph-btn ghost sm danger" @click="confirmArchiveProject(sel)">Archive</button>
                  </div>
                </div>
                <p v-if="sel.description">{{ sel.description }}</p>
                <div class="ph-lead-meta">
                  <span class="ph-pill" :class="{ hb: isHeartbeat(sel) }">{{ sel.status }}</span>
                  <span class="ph-pill">{{ sel.priority }}</span>
                  <span v-if="sel.owner" class="ph-pill">owner: {{ sel.owner }}</span>
                  <span v-if="sel.github_repo" class="ph-pill">{{ sel.github_repo }}</span>
                </div>
              </div>

              <div
                v-for="epic in sel.epics"
                :key="epic.id"
                class="ph-sec"
                :class="{ 'drop-epic': dnd.kind === 'epic' && dragOverEpicId === epic.id }"
                @dragover.prevent="dragOverEpicId = epic.id"
                @dragleave="dragOverEpicId = ''"
                @drop="onSectionDrop(epic)"
              >
                <div class="ph-sec-h">
                  <span
                    class="ph-drag"
                    draggable="true"
                    title="Drag to reorder epic"
                    @dragstart="onDragStartEpic(epic, $event)"
                    @dragend="onDragEnd"
                  >⠿</span>
                  <h3>{{ epic.title }}</h3>
                  <span class="ph-cnt">{{ epicSummary(epic) }}</span>
                  <div class="ph-sp" />
                  <div class="ph-actions">
                    <button type="button" class="ph-btn ghost xs" @click="openNewTask(epic.id)">＋ Issue</button>
                    <button type="button" class="ph-btn ghost xs" @click="openEditEpic(epic)">Edit</button>
                    <button type="button" class="ph-btn ghost xs danger" @click="confirmArchiveEpic(epic)">Archive</button>
                  </div>
                </div>
                <div v-if="!epic.tasks.length" class="ph-muted ph-dropzone">Drop an issue here, or ＋ Issue to add one.</div>
                <div
                  v-for="t in epic.tasks"
                  :key="t.id"
                  class="ph-row"
                  :class="{ sel: openTask?.id === t.id, drop: dnd.kind === 'task' && dragOverTaskId === t.id }"
                  draggable="true"
                  @click="openTaskDrawer(t)"
                  @dragstart.stop="onDragStartTask(t, epic.id, $event)"
                  @dragend="onDragEnd"
                  @dragover.prevent.stop="dragOverTaskId = t.id"
                  @dragleave.stop="dragOverTaskId = ''"
                  @drop.stop="onRowDrop(t, epic)"
                >
                  <span class="ph-grip">⠿</span>
                  <span class="ph-mark" :class="markClass(t.status)" />
                  <div class="ph-rbody">
                    <div class="ph-t" v-html="cleanTitle(t.title)" />
                    <div v-if="showPriority(t.priority)" class="ph-m"><span>{{ t.priority }}</span></div>
                  </div>
                  <span class="ph-tag" :class="{ wait: isBlockedStatus(t.status) }">{{ statusLabel(t.status) }}</span>
                </div>
              </div>
              <div v-if="!sel.epics.length" class="ph-muted">
                No epics yet. <button type="button" class="ph-btn xs" @click="openNewEpic(sel.id)">＋ Add an epic</button>
              </div>
            </div>

            <!-- BOARD -->
            <div v-show="tab === 'board'" v-if="sel">
              <div class="ph-cols">
                <div
                  v-for="col in boardColumns"
                  :key="col.key"
                  class="ph-col"
                  :class="{ 'drop-col': dnd.kind === 'task' && dragOverCol === col.key }"
                  @dragover.prevent="dragOverCol = col.key"
                  @dragleave="dragOverCol = ''"
                  @drop="onColumnDrop(col.key)"
                >
                  <div class="ph-colh">
                    <span class="ph-cd" :style="{ background: col.color }" />{{ col.label }} <span class="ph-n">{{ col.items.length }}</span>
                    <span class="ph-sp" />
                    <button type="button" class="ph-lane-action" :aria-label="`Customize ${col.label}`" @click="openLaneEditor(col.key)">Customize</button>
                    <button type="button" class="ph-lane-action" :aria-label="`Assign workflow to ${col.label}`" @click="openLaneAssignment(col.key)">Automate</button>
                  </div>
                  <div v-if="!col.items.length" class="ph-card ghost"><div class="ph-ct">Drop here</div></div>
                  <div
                    v-for="t in col.items"
                    :key="t.id"
                    class="ph-card"
                    draggable="true"
                    @click="openTaskDrawer(t)"
                    @dragstart="onDragStartTask(t, t.epic_id, $event)"
                    @dragend="onDragEnd"
                  >
                    <div class="ph-ct" v-html="cleanTitle(t.title)" />
                    <div v-if="showPriority(t.priority)" class="ph-cm">{{ t.priority }}</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- ACTIVITY -->
            <div v-show="tab === 'activity'" v-if="sel">
              <div class="ph-lead ph-activity-lead">
                <div class="ph-lead-row">
                  <h2>Recent activity</h2>
                  <div class="ph-actions">
                    <button type="button" class="ph-btn ghost sm" @click="refreshActivity" :disabled="activityLoading">
                      {{ activityLoading ? 'Loading…' : '↻ Refresh' }}
                    </button>
                  </div>
                </div>
                <p>{{ shortName(sel) }} · newest first — comments, new tasks &amp; epics, status and metadata changes.</p>
              </div>
              <div v-if="activityLoading && !activity.length" class="ph-state">Loading recent activity…</div>
              <div v-else-if="!activity.length" class="ph-state">No activity has been recorded for this project yet.</div>
              <div v-else class="ph-timeline">
                <button
                  v-for="item in activity"
                  :key="item.id"
                  type="button"
                  class="ph-activity"
                  :class="{ 'is-event': item.kind !== 'comment' }"
                  @click="openActivityTask(item)"
                >
                  <span class="ph-activity-dot" :class="[activityActorClass(item), { event: item.kind !== 'comment' }]" />
                  <span class="ph-activity-body">
                    <span class="ph-activity-meta">
                      <span class="ph-activity-kind" :class="'k-' + item.kind">{{ activityKindLabel(item.kind) }}</span>
                      <span class="ph-activity-actor" :class="activityActorClass(item)">{{ activityActorLabel(item) }}</span>
                      <span>{{ shortDate(item.activity_at) }}</span>
                      <span v-if="item.epic_title">{{ item.epic_title }}</span>
                    </span>
                    <span class="ph-activity-task" v-html="cleanTitle(activityTitle(item))" />
                    <span class="ph-activity-text">{{ activityText(item) }}</span>
                  </span>
                  <span class="ph-tag" :class="{ wait: isBlockedStatus(item.task_status) }">{{ statusLabel(item.task_status) }}</span>
                </button>
              </div>
            </div>

            <!-- PROJECTS -->
            <div v-show="tab === 'projects'">
              <div class="ph-grid">
                <div v-for="p in projects" :key="p.id" class="ph-pcard" @click="select(p.id); tab = 'today'">
                  <div class="ph-lane" :class="{ hb: isHeartbeat(p) }">{{ laneLabel(p) }}</div>
                  <h3>{{ shortName(p) }}</h3>
                  <p v-if="p.description">{{ p.description }}</p>
                  <div class="ph-prog" :class="progClass(p)"><i :style="{ width: pct(p) + '%' }" /></div>
                  <div class="ph-nums">
                    <span><b>{{ p.openCount }}</b> open</span>
                    <span><b>{{ p.doneCount }}</b> done</span>
                    <span><b>{{ p.epics.length }}</b> epics</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- LANE SETTINGS -->
            <LaneSettings v-if="sel" v-show="tab === 'lanes'" ref="laneSettings" :project="sel" @refresh="refresh" />
          </template>
        </div>
      </section>
    </div>

    <!-- ══════════ TASK DETAIL DRAWER ══════════ -->
    <div v-if="openTask" class="ph-scrim" @click="closeTask" />
    <aside v-if="openTask" class="ph-drawer">
      <div class="ph-dh">
        <div class="ph-dh-id">{{ taskMode === 'create' ? 'NEW ISSUE' : `ISSUE · ${ openTask.id }` }}</div>
        <button type="button" class="ph-x" @click="closeTask">✕</button>
      </div>
      <div class="ph-db">
        <label class="ph-fl">Title</label>
        <textarea v-model="taskDraft.title" class="ph-in ph-ta" rows="2" placeholder="What needs doing?" />

        <div class="ph-frow">
          <div>
            <label class="ph-fl">Status</label>
            <select v-model="taskDraft.status" class="ph-in">
              <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
            </select>
          </div>
          <div>
            <label class="ph-fl">Priority</label>
            <select v-model="taskDraft.priority" class="ph-in">
              <option v-for="p in PRIORITIES" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
        </div>

        <div class="ph-frow">
          <div>
            <label class="ph-fl">Epic</label>
            <select v-model="taskDraft.epic_id" class="ph-in">
              <option v-for="e in (sel?.epics ?? [])" :key="e.id" :value="e.id">{{ e.title }}</option>
            </select>
          </div>
          <div>
            <label class="ph-fl">Assignee</label>
            <select v-model="taskDraft.assignee" class="ph-in">
              <option value="">unassigned</option>
              <option v-for="a in ASSIGNEES" :key="a.value" :value="a.value">{{ a.label }}</option>
              <option v-if="taskDraft.assignee && !isKnownAssignee(taskDraft.assignee)" :value="taskDraft.assignee">
                {{ taskDraft.assignee }}
              </option>
            </select>
          </div>
        </div>

        <div class="ph-frow">
          <div>
            <label class="ph-fl">Due</label>
            <input v-model="taskDueYmd" type="date" class="ph-in">
          </div>
          <div>
            <label class="ph-fl">GitHub issue</label>
            <input v-model="taskDraft.github_issue" class="ph-in" placeholder="owner/repo#123">
          </div>
        </div>

        <label class="ph-fl">Description</label>
        <textarea v-model="taskDraft.description" class="ph-in ph-ta" rows="4" placeholder="Details, context, next action…" />

        <div class="ph-dactions">
          <button type="button" class="ph-btn primary" :disabled="saving || !taskDraft.title" @click="saveTask">
            {{ saving ? 'Saving…' : (taskMode === 'create' ? 'Create issue' : 'Save changes') }}
          </button>
          <button v-if="taskMode === 'edit'" type="button" class="ph-btn ghost danger" :disabled="saving" @click="confirmArchiveTask">Archive</button>
        </div>

        <!-- comments -->
        <template v-if="taskMode === 'edit'">
          <div class="ph-cmt-h">Comments <span>{{ taskComments.length }}</span></div>
          <div v-for="c in taskComments" :key="c.id" class="ph-cmt">
            <div class="ph-cmt-who">{{ c.author || 'agent' }} · {{ shortDate(c.created_at) }}</div>
            <div class="ph-cmt-b">{{ c.body }}</div>
          </div>
          <div v-if="!taskComments.length" class="ph-muted">No comments yet.</div>
          <div class="ph-cmt-add">
            <textarea v-model="newComment" class="ph-in ph-ta" rows="2" placeholder="Add a comment…" />
            <button type="button" class="ph-btn" :disabled="saving || !newComment.trim()" @click="postComment">Comment</button>
          </div>
        </template>
      </div>
    </aside>

    <!-- ══════════ PROJECT MODAL ══════════ -->
    <div v-if="projectModal.open" class="ph-scrim center" @click="projectModal.open = false">
      <div class="ph-modal" @click.stop>
        <h2>{{ projectModal.mode === 'create' ? 'New project' : 'Edit project' }}</h2>
        <label class="ph-fl">Title</label>
        <input v-model="projectDraft.title" class="ph-in" placeholder="Project name">
        <label class="ph-fl">Description</label>
        <textarea v-model="projectDraft.description" class="ph-in ph-ta" rows="3" />
        <div class="ph-frow">
          <div>
            <label class="ph-fl">Status</label>
            <select v-model="projectDraft.status" class="ph-in">
              <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
            </select>
          </div>
          <div>
            <label class="ph-fl">Priority</label>
            <select v-model="projectDraft.priority" class="ph-in">
              <option v-for="p in PRIORITIES" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
        </div>
        <div class="ph-frow">
          <div>
            <label class="ph-fl">Owner</label>
            <input v-model="projectDraft.owner" class="ph-in" placeholder="who owns it">
          </div>
          <div>
            <label class="ph-fl">GitHub repo</label>
            <input v-model="projectDraft.github_repo" class="ph-in" placeholder="owner/repo">
          </div>
        </div>
        <label class="ph-fl">Outcome metric</label>
        <input v-model="projectDraft.outcome_metric" class="ph-in" placeholder="how you know it's done">
        <div class="ph-dactions">
          <button type="button" class="ph-btn primary" :disabled="saving || !projectDraft.title" @click="saveProject">
            {{ saving ? 'Saving…' : (projectModal.mode === 'create' ? 'Create' : 'Save') }}
          </button>
          <button type="button" class="ph-btn ghost" @click="projectModal.open = false">Cancel</button>
        </div>
      </div>
    </div>

    <!-- ══════════ EPIC MODAL ══════════ -->
    <div v-if="epicModal.open" class="ph-scrim center" @click="epicModal.open = false">
      <div class="ph-modal" @click.stop>
        <h2>{{ epicModal.mode === 'create' ? 'New epic' : 'Edit epic' }}</h2>
        <label class="ph-fl">Title</label>
        <input v-model="epicDraft.title" class="ph-in" placeholder="Epic name">
        <label class="ph-fl">Description</label>
        <textarea v-model="epicDraft.description" class="ph-in ph-ta" rows="3" />
        <div class="ph-frow">
          <div>
            <label class="ph-fl">Status</label>
            <select v-model="epicDraft.status" class="ph-in">
              <option v-for="s in STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
            </select>
          </div>
          <div>
            <label class="ph-fl">Priority</label>
            <select v-model="epicDraft.priority" class="ph-in">
              <option v-for="p in PRIORITIES" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
        </div>
        <div class="ph-dactions">
          <button type="button" class="ph-btn primary" :disabled="saving || !epicDraft.title" @click="saveEpic">
            {{ saving ? 'Saving…' : (epicModal.mode === 'create' ? 'Create' : 'Save') }}
          </button>
          <button type="button" class="ph-btn ghost" @click="epicModal.open = false">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';

import LaneSettings from '@pkg/components/projects/LaneSettings.vue';
import {
  useProjects,
  type ProjectView, type EpicWithTasks, type TaskView, type WorkTaskRecord, type WorkCommentRecord, type WorkActivityRecord,
  type UpsertProjectInput, type UpsertEpicInput, type UpsertTaskInput, type ReorderUpdate,
} from '@pkg/composables/useProjects';

const {
  projects, selected: sel, selectedId, isLoading, error, loaded, load, select,
  loadComments, loadActivity, createProject, updateProject, archiveProject,
  createEpic, updateEpic, archiveEpic,
  createTask, updateTask, archiveTask, addComment, reorder,
  lanesByProject, laneCapability,
} = useProjects();

const tab = ref<'today' | 'board' | 'activity' | 'projects' | 'lanes'>('today');
const saving = ref(false);
const activity = ref<WorkActivityRecord[]>([]);
const activityLoading = ref(false);
const laneSettings = ref<InstanceType<typeof LaneSettings> | null>(null);

const selectedLanes = computed(() => selectedId.value ? (lanesByProject.value[selectedId.value] ?? []) : []);
const COMPATIBILITY_LANE_KEYS = ['backlog', 'todo', 'planning', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled', 'parked'];
const STATUSES = computed(() => selectedLanes.value.length
  ? selectedLanes.value.map(lane => lane.lane_key)
  : COMPATIBILITY_LANE_KEYS);
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
// Canonical assignees. Values are the exact lowercase tokens the Projects tools and
// the Heartbeat lane filter match on — 'heartbeat' is what routes work into the
// autonomous agent's queue, so it must stay lowercase and spelled this way.
const ASSIGNEES = [
  { value: 'heartbeat', label: 'Heartbeat (autonomous)' },
  { value: 'sulla', label: 'Sulla' },
  { value: 'human', label: 'Human' },
];
function isKnownAssignee(a: string): boolean {
  return ASSIGNEES.some(x => x.value === a);
}

onMounted(() => {
  load().catch((err) => {
    console.error('[ProjectsHome] initial load failed:', err);
  });
});

watch([tab, selectedId], () => {
  if (tab.value === 'activity') {
    refreshActivity().catch((err) => {
      console.error('[ProjectsHome] activity refresh failed:', err);
    });
  }
});

async function refresh(): Promise<void> {
  await load();
  if (tab.value === 'activity') await refreshActivity();
}

async function refreshActivity(): Promise<void> {
  if (!selectedId.value) {
    activity.value = [];
    return;
  }
  activityLoading.value = true;
  try {
    activity.value = await loadActivity(selectedId.value, 80);
  } finally {
    activityLoading.value = false;
  }
}

// ── grouping for the sidebar ──────────────────────────────────────────
const groups = computed(() => {
  const heartbeat: ProjectView[] = [];
  const stack: ProjectView[] = [];
  const closed: ProjectView[] = [];
  for (const p of projects.value) {
    if (p.status === 'done') closed.push(p);
    else if (isHeartbeat(p)) heartbeat.push(p);
    else stack.push(p);
  }

  return [
    { label: 'Heartbeat’s lane', items: heartbeat },
    { label: 'Your stack', items: stack },
    { label: 'Closed', items: closed },
  ];
});

function isHeartbeat(p: ProjectView): boolean {
  return p.slug === 'goal-operator-transition' || /operator platform/i.test(p.title);
}
function laneLabel(p: ProjectView): string {
  if (p.status === 'done') return 'Closed';
  if (isHeartbeat(p)) return 'Heartbeat lane';

  return 'Your stack';
}

// ── display helpers ───────────────────────────────────────────────────
function shortName(p: ProjectView): string {
  return p.title.split(' (')[0].split(' — ')[0].trim();
}
function dotClass(p: ProjectView): string {
  if (p.status === 'done') return 'done';
  if (p.status === 'blocked') return 'block';
  if (p.status === 'backlog') return 'hold';

  return 'go';
}

const CLEAN_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function cleanTitle(raw: string): string {
  let s = (raw || '').replace(/[&<>]/g, c => CLEAN_ESC[c]);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+?)`/g, '<code>$1</code>');

  return s;
}

function laneForStatus(status: string) {
  return selectedLanes.value.find(lane => lane.lane_key === status);
}
function semanticRole(status: string): string {
  return laneForStatus(status)?.semantic_role ?? 'manual';
}
function isBlockedStatus(status: string): boolean {
  return semanticRole(status) === 'blocked';
}
function markClass(status: string): string {
  const role = semanticRole(status);
  if (role === 'blocked') return 'wait';
  if (role === 'terminal' || role === 'manual') return 'gray';
  return 'hi';
}

function statusLabel(status: string): string {
  return laneForStatus(status)?.display_name ?? status;
}
function showPriority(pr: string): boolean {
  return pr === 'high' || pr === 'critical' || pr === 'p0' || pr === 'p1';
}
function epicSummary(epic: EpicWithTasks): string {
  let open = 0;
  let done = 0;
  for (const t of epic.tasks) {
    if (t.lane?.semantic_role === 'terminal') done++;
    else open++;
  }
  const parts: string[] = [];
  if (open) parts.push(`${ open } open`);
  if (done) parts.push(`${ done } done`);

  return parts.join(' · ') || 'empty';
}
function pct(p: ProjectView): number {
  const total = p.openCount + p.doneCount;

  return total ? Math.round((100 * p.doneCount) / total) : 0;
}
function progClass(p: ProjectView): string {
  if (p.status === 'blocked') return 'amber';
  if (p.status === 'backlog' || p.status === 'done') return 'gray';

  return '';
}
function shortDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);

  return `${ d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } ${ d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }`;
}

// ── board columns for the selected project ────────────────────────────
type Task = TaskView;
const boardColumns = computed(() => {
  const tasks: Task[] = [];
  if (sel.value) {
    for (const epic of sel.value.epics) {
      tasks.push(...epic.tasks);
    }
  }
  const known = new Set(selectedLanes.value.map(lane => lane.lane_key));
  const columns = selectedLanes.value.map(lane => ({
    key: lane.lane_key,
    label: lane.display_name,
    color: lane.color || (lane.semantic_role === 'blocked' ? 'var(--pamber)' : lane.semantic_role === 'terminal' ? 'var(--ptext3)' : 'var(--pacc)'),
    items: tasks.filter(task => task.status === lane.lane_key),
  }));
  for (const status of new Set(tasks.filter(task => !known.has(task.status)).map(task => task.status))) {
    columns.push({ key: status, label: status, color: 'var(--ptext3)', items: tasks.filter(task => task.status === status) });
  }
  return columns;
});

function openLaneEditor(laneKey: string): void {
  const lane = selectedLanes.value.find(item => item.lane_key === laneKey);
  if (!lane) return;
  tab.value = 'lanes';
  laneSettings.value?.openEdit(lane);
}

function openLaneAssignment(laneKey: string): void {
  const lane = selectedLanes.value.find(item => item.lane_key === laneKey);
  if (!lane) return;
  laneSettings.value?.openAssignment(lane);
}

// ══════════ DRAG TO REORDER ══════════
// Native HTML5 DnD. A drag carries { kind, id, fromEpicId }; on drop we rebuild
// the affected list, stamp position = index, and send one reorder() batch
// (which also carries status for board moves and epic_id for cross-epic moves).
const dnd = reactive<{ kind: 'task' | 'epic' | null; id: string; fromEpicId: string }>({ kind: null, id: '', fromEpicId: '' });
const dragOverTaskId = ref('');
const dragOverEpicId = ref('');
const dragOverCol = ref('');

function onDragStartTask(t: WorkTaskRecord, epicId: string | null, ev: DragEvent): void {
  dnd.kind = 'task';
  dnd.id = t.id;
  dnd.fromEpicId = epicId ?? '';
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
}
function onDragStartEpic(epic: EpicWithTasks, ev: DragEvent): void {
  dnd.kind = 'epic';
  dnd.id = epic.id;
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
}
function onDragEnd(): void {
  dnd.kind = null; dnd.id = ''; dnd.fromEpicId = '';
  dragOverTaskId.value = ''; dragOverEpicId.value = ''; dragOverCol.value = '';
}

/** Drop a dragged task into `targetEpic`, positioned before `beforeId` (or at end). */
async function moveTaskInto(targetEpic: EpicWithTasks, beforeId: string | null): Promise<void> {
  const draggedId = dnd.id;
  const fromEpicId = dnd.fromEpicId;
  if (dnd.kind !== 'task' || !draggedId) return;
  const rest = targetEpic.tasks.filter(t => t.id !== draggedId);
  let idx = beforeId ? rest.findIndex(t => t.id === beforeId) : rest.length;
  if (idx === -1) idx = rest.length;
  const ids = rest.map(t => t.id);
  ids.splice(idx, 0, draggedId);
  const crossEpic = fromEpicId !== targetEpic.id;
  const updates: ReorderUpdate[] = ids.map((id, i) => ({
    kind: 'task', id, position: i, ...(id === draggedId && crossEpic ? { epic_id: targetEpic.id } : {}),
  }));
  onDragEnd();
  await reorder(updates);
}

async function onRowDrop(target: WorkTaskRecord, epic: EpicWithTasks): Promise<void> {
  if (dnd.kind === 'task') await moveTaskInto(epic, target.id);
}

async function onSectionDrop(epic: EpicWithTasks): Promise<void> {
  if (dnd.kind === 'task') {
    await moveTaskInto(epic, null);          // append to this epic
  } else if (dnd.kind === 'epic' && sel.value) {
    const draggedId = dnd.id;
    const rest = sel.value.epics.filter(e => e.id !== draggedId);
    let idx = rest.findIndex(e => e.id === epic.id);
    if (idx === -1) idx = rest.length;
    const ids = rest.map(e => e.id);
    ids.splice(idx, 0, draggedId);
    const updates: ReorderUpdate[] = ids.map((id, i) => ({ kind: 'epic', id, position: i }));
    onDragEnd();
    await reorder(updates);
  }
}

async function onColumnDrop(colKey: string): Promise<void> {
  if (dnd.kind !== 'task') return;
  const id = dnd.id;
  onDragEnd();
  if (colKey) await reorder([{ kind: 'task', id, status: colKey }]);
}

// ══ date helpers ══
function ymd(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}
function isoFromYmd(v: string): string | null {
  return v ? new Date(`${ v }T00:00:00`).toISOString() : null;
}

// ══════════ TASK DRAWER ══════════
type TaskDraft = UpsertTaskInput & { id?: string };
const openTask = ref<WorkTaskRecord | null>(null);
const taskMode = ref<'edit' | 'create'>('edit');
const taskDraft = reactive<TaskDraft>({ title: '' });
const taskComments = ref<WorkCommentRecord[]>([]);
const newComment = ref('');

const taskDueYmd = computed<string>({
  get: () => ymd(taskDraft.due_at),
  set: (v: string) => { taskDraft.due_at = isoFromYmd(v); },
});

function fillTaskDraft(t: Partial<WorkTaskRecord> & { epic_id?: string | null }): void {
  taskDraft.id = (t as WorkTaskRecord).id;
  taskDraft.title = t.title ?? '';
  taskDraft.description = t.description ?? '';
  taskDraft.status = t.status ?? defaultTaskStatus();
  taskDraft.priority = t.priority ?? 'medium';
  taskDraft.epic_id = t.epic_id ?? (sel.value?.epics[0]?.id ?? null);
  taskDraft.assignee = t.assignee ?? '';
  taskDraft.due_at = t.due_at ?? null;
  taskDraft.github_issue = t.github_issue ?? '';
}

function defaultTaskStatus(): string | undefined {
  if (!laneCapability.value?.ready) return 'todo';

  return selectedLanes.value.find(lane => lane.semantic_role === 'execution')?.lane_key;
}

async function openTaskDrawer(t: WorkTaskRecord): Promise<void> {
  taskMode.value = 'edit';
  openTask.value = t;
  fillTaskDraft(t);
  taskComments.value = await loadComments(t.id);
}

async function openActivityTask(item: WorkActivityRecord): Promise<void> {
  if (!item.task_id) return;
  const task = sel.value?.epics
    .flatMap(epic => epic.tasks)
    .find(t => t.id === item.task_id);
  if (task) await openTaskDrawer(task);
}

const ACTIVITY_KIND_LABELS: Record<WorkActivityRecord['kind'], string> = {
  comment:          'Comment',
  task_created:     'New task',
  task_updated:     'Task edited',
  task_moved:       'Status',
  epic_created:     'New epic',
  epic_updated:     'Epic edited',
  project_created:  'New project',
  project_updated:  'Project edited',
};

function activityKindLabel(kind: WorkActivityRecord['kind']): string {
  return ACTIVITY_KIND_LABELS[kind] ?? 'Activity';
}

function normalizeActivityActor(author: string | null): string {
  const actor = (author || 'sulla').trim().toLowerCase();
  if (!actor || actor === 'agent') return 'sulla';
  return actor;
}

function activityActorLabel(item: WorkActivityRecord): string {
  const actor = normalizeActivityActor(item.author);
  if (actor === 'heartbeat') return 'Heartbeat';
  if (actor === 'human') return 'You';
  if (actor === 'sulla') return 'Sulla';
  if (actor === 'workbench') return 'Workbench';
  return actor.charAt(0).toUpperCase() + actor.slice(1);
}

function activityActorClass(item: WorkActivityRecord): string {
  const actor = normalizeActivityActor(item.author);
  if (actor === 'heartbeat') return 'heartbeat';
  if (actor === 'human') return 'human';
  if (actor === 'workbench') return 'workbench';
  if (actor === 'sulla') return 'sulla';
  return 'other';
}

/** The headline for a row — the subject item's title, whatever level it lives at. */
function activityTitle(item: WorkActivityRecord): string {
  if (item.task_title) return item.task_title;
  if (item.epic_title) return item.epic_title;
  return item.project_title;
}

/** Body text: real comment bodies, or a short synthesized description for lifecycle events. */
function activityText(item: WorkActivityRecord): string {
  if (item.kind === 'comment') return item.body ?? '';
  const status = statusLabel(item.task_status);
  switch (item.kind) {
  case 'task_created': return 'Task added to Projects.';
  case 'task_moved': return `Moved to ${ status }.`;
  case 'task_updated': return 'Task details updated.';
  case 'epic_created': return 'Epic created.';
  case 'epic_updated': return `Epic updated · ${ status }.`;
  case 'project_created': return 'Project created.';
  case 'project_updated': return `Project updated · ${ status }.`;
  default: return '';
  }
}

function openNewTask(epicId: string): void {
  taskMode.value = 'create';
  openTask.value = { id: '' } as WorkTaskRecord;
  fillTaskDraft({ epic_id: epicId, priority: 'medium' });
  taskComments.value = [];
}

function closeTask(): void {
  openTask.value = null;
  newComment.value = '';
}

async function saveTask(): Promise<void> {
  if (!taskDraft.title) return;
  saving.value = true;
  try {
    if (taskMode.value === 'create') {
      await createTask({
        epic_id:      taskDraft.epic_id ?? undefined,
        title:        taskDraft.title,
        description:  taskDraft.description,
        status:       taskDraft.status,
        priority:     taskDraft.priority,
        assignee:     taskDraft.assignee || null,
        due_at:       taskDraft.due_at ?? null,
        github_issue: taskDraft.github_issue || null,
      });
    } else if (taskDraft.id) {
      await updateTask(taskDraft.id, {
        epic_id:      taskDraft.epic_id ?? undefined,
        title:        taskDraft.title,
        description:  taskDraft.description,
        status:       taskDraft.status,
        priority:     taskDraft.priority,
        assignee:     taskDraft.assignee || null,
        due_at:       taskDraft.due_at ?? null,
        github_issue: taskDraft.github_issue || null,
      });
    }
    closeTask();
  } finally {
    saving.value = false;
  }
}

async function confirmArchiveTask(): Promise<void> {
  if (!taskDraft.id) return;
  if (!window.confirm('Archive this issue? It will be hidden from the board (soft-delete).')) return;
  saving.value = true;
  try {
    await archiveTask(taskDraft.id);
    closeTask();
  } finally {
    saving.value = false;
  }
}

async function postComment(): Promise<void> {
  const body = newComment.value.trim();
  if (!body || !taskDraft.id) return;
  saving.value = true;
  try {
    await addComment(taskDraft.id, body, 'human');
    taskComments.value = await loadComments(taskDraft.id);
    if (tab.value === 'activity') await refreshActivity();
    newComment.value = '';
  } finally {
    saving.value = false;
  }
}

// ══════════ PROJECT MODAL ══════════
type ProjectDraft = UpsertProjectInput & { id?: string };
const projectModal = reactive<{ open: boolean; mode: 'create' | 'edit' }>({ open: false, mode: 'create' });
const projectDraft = reactive<ProjectDraft>({ title: '' });

function openNewProject(): void {
  projectModal.mode = 'create';
  Object.assign(projectDraft, {
    id: undefined, title: '', description: '', status: 'backlog', priority: 'medium', owner: '', github_repo: '', outcome_metric: '',
  });
  projectModal.open = true;
}
function openEditProject(p: ProjectView): void {
  projectModal.mode = 'edit';
  Object.assign(projectDraft, {
    id: p.id, title: p.title, description: p.description, status: p.status, priority: p.priority,
    owner: p.owner ?? '', github_repo: p.github_repo ?? '', outcome_metric: p.outcome_metric ?? '',
  });
  projectModal.open = true;
}
async function saveProject(): Promise<void> {
  if (!projectDraft.title) return;
  saving.value = true;
  try {
    if (projectModal.mode === 'create') {
      await createProject({
        title: projectDraft.title, description: projectDraft.description, status: projectDraft.status,
        priority: projectDraft.priority, owner: projectDraft.owner || null,
        github_repo: projectDraft.github_repo || null, outcome_metric: projectDraft.outcome_metric || null,
      });
    } else if (projectDraft.id) {
      await updateProject(projectDraft.id, {
        title: projectDraft.title, description: projectDraft.description, status: projectDraft.status,
        priority: projectDraft.priority, owner: projectDraft.owner || null,
        github_repo: projectDraft.github_repo || null, outcome_metric: projectDraft.outcome_metric || null,
      });
    }
    projectModal.open = false;
  } finally {
    saving.value = false;
  }
}
async function confirmArchiveProject(p: ProjectView): Promise<void> {
  if (!window.confirm(`Archive "${ shortName(p) }" and all its epics and issues? (soft-delete)`)) return;
  saving.value = true;
  try {
    await archiveProject(p.id);
  } finally {
    saving.value = false;
  }
}

// ══════════ EPIC MODAL ══════════
type EpicDraft = UpsertEpicInput & { id?: string };
const epicModal = reactive<{ open: boolean; mode: 'create' | 'edit' }>({ open: false, mode: 'create' });
const epicDraft = reactive<EpicDraft>({ project_id: '', title: '' });

function openNewEpic(projectId: string): void {
  epicModal.mode = 'create';
  Object.assign(epicDraft, { id: undefined, project_id: projectId, title: '', description: '', status: 'todo', priority: 'medium' });
  epicModal.open = true;
}
function openEditEpic(e: EpicWithTasks): void {
  epicModal.mode = 'edit';
  Object.assign(epicDraft, { id: e.id, project_id: e.project_id, title: e.title, description: e.description, status: e.status, priority: e.priority });
  epicModal.open = true;
}
async function saveEpic(): Promise<void> {
  if (!epicDraft.title) return;
  saving.value = true;
  try {
    if (epicModal.mode === 'create') {
      await createEpic({
        project_id: epicDraft.project_id, title: epicDraft.title, description: epicDraft.description,
        status: epicDraft.status, priority: epicDraft.priority,
      });
    } else if (epicDraft.id) {
      await updateEpic(epicDraft.id, {
        title: epicDraft.title, description: epicDraft.description, status: epicDraft.status, priority: epicDraft.priority,
      });
    }
    epicModal.open = false;
  } finally {
    saving.value = false;
  }
}
async function confirmArchiveEpic(e: EpicWithTasks): Promise<void> {
  if (!window.confirm(`Archive epic "${ e.title }" and its issues? (soft-delete)`)) return;
  saving.value = true;
  try {
    await archiveEpic(e.id);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped lang="scss">
@import '@pkg/assets/styles/routines-theme.scss';

.projects-home {
  @include routines-theme-vars;

  --pbg:          #0b0f17;
  --psurface:     #11161f;
  --psurface2:    #161c27;
  --pborder:      #212a38;
  --pborder-soft: #1a212d;
  --ptext:        var(--text, #eef2f8);
  --ptext2:       #9aa7b8;
  --ptext3:       #5f6b7c;
  --pacc:         var(--steel-400, #5096b3);
  --pacc-soft:    rgba(80, 150, 179, 0.14);
  --pacc-line:    rgba(80, 150, 179, 0.40);
  --pgreen:       #5ba37d;
  --pamber:       #c99a54;
  --pred:         #c9736f;
  --pserif:       var(--serif, 'Playfair Display', Georgia, serif);
  --pmono:        var(--mono, ui-monospace, 'JetBrains Mono', Menlo, monospace);
  --psans:        var(--sans, 'Inter', system-ui, sans-serif);

  height: 100%;
  min-height: 0;
  position: relative;
  background: var(--pbg);
  color: var(--ptext);
  font-family: var(--psans);
}
.projects-home * { box-sizing: border-box; }
.projects-home code { font-family: var(--pmono); font-size: 0.85em; color: #b9d3df; }

.ph-body { display: flex; height: 100%; min-height: 0; }

/* buttons */
.ph-btn {
  font-family: var(--psans); font-size: 12.5px; font-weight: 500; color: var(--ptext);
  background: var(--pacc-soft); border: 1px solid var(--pacc-line); border-radius: 8px;
  padding: 7px 12px; cursor: pointer; white-space: nowrap;
}
.ph-btn:hover { background: rgba(80, 150, 179, 0.22); }
.ph-btn:disabled { opacity: 0.5; cursor: default; }
.ph-btn.primary { background: var(--pacc); border-color: var(--pacc); color: #06121a; }
.ph-btn.ghost { background: transparent; border-color: var(--pborder); color: var(--ptext2); }
.ph-btn.ghost:hover { color: var(--ptext); border-color: var(--pacc-line); background: rgba(255, 255, 255, 0.03); }
.ph-btn.block { width: 100%; }
.ph-btn.sm { padding: 5px 10px; font-size: 12px; }
.ph-btn.xs { padding: 3px 8px; font-size: 11px; border-radius: 6px; }
.ph-btn.danger { color: var(--pred); border-color: rgba(201, 115, 111, 0.35); }
.ph-btn.danger:hover { color: #e59a96; border-color: rgba(201, 115, 111, 0.6); background: rgba(201, 115, 111, 0.08); }

/* sidebar */
.ph-side { width: 248px; flex-shrink: 0; border-right: 1px solid var(--pborder); background: var(--psurface); display: flex; flex-direction: column; min-height: 0; }
.ph-side-h { padding: 22px 20px 10px; }
.ph-eyebrow { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--pacc); margin-bottom: 6px; }
.ph-side-h h1 { font-family: var(--pserif); font-weight: 500; font-size: 24px; margin: 0; color: var(--ptext); }
.ph-list { padding: 6px 12px 12px; overflow: auto; min-height: 0; flex: 1; }
.ph-side-f { padding: 10px 12px 14px; border-top: 1px solid var(--pborder-soft); }
.ph-grp { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ptext3); padding: 14px 8px 6px; }
.ph-p { display: block; width: 100%; text-align: left; padding: 9px 10px; border-radius: 9px; margin-bottom: 2px; border: 1px solid transparent; background: transparent; cursor: pointer; color: var(--ptext); }
.ph-p:hover { background: rgba(255, 255, 255, 0.03); }
.ph-p.on { background: var(--pacc-soft); border-color: var(--pacc-line); }
.ph-pn { font-size: 13.5px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.ph-st { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.ph-st.go { background: var(--pacc); }
.ph-st.hold { background: var(--ptext3); }
.ph-st.block { background: var(--pamber); }
.ph-st.done { background: var(--pgreen); }
.ph-pc { display: block; font-size: 11.5px; color: var(--ptext3); margin: 4px 0 0 15px; }

/* main */
.ph-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.ph-top { display: flex; align-items: center; gap: 16px; padding: 18px 26px; border-bottom: 1px solid var(--pborder); }
.ph-tabs { display: flex; gap: 26px; }
.ph-tab { font-family: var(--psans); font-size: 14px; color: var(--ptext3); padding: 0 0 4px; cursor: pointer; border: none; background: transparent; border-bottom: 2px solid transparent; }
.ph-tab:hover { color: var(--ptext2); }
.ph-tab.on { color: var(--ptext); border-bottom-color: var(--pacc); }
.ph-sp { flex: 1; }

.ph-canvas { flex: 1; overflow: auto; padding: 26px 28px 36px; min-height: 0; }
.ph-state { color: var(--ptext2); font-size: 14px; padding: 20px 2px; }
.ph-err b { color: var(--ptext); display: block; margin-bottom: 6px; }
.ph-err p { color: var(--pamber); font-family: var(--pmono); font-size: 12px; margin: 0 0 12px; }
.ph-muted { color: var(--ptext3); font-size: 13px; padding: 4px 2px 10px; }
.ph-actions { display: flex; gap: 6px; }

/* today */
.ph-lead { margin: 0 0 26px; }
.ph-lead-row { display: flex; align-items: flex-start; gap: 16px; }
.ph-lead h2 { font-family: var(--pserif); font-weight: 500; font-size: 26px; margin: 0 0 8px; line-height: 1.25; color: var(--ptext); flex: 1; }
.ph-lead p { margin: 0; color: var(--ptext2); font-size: 14px; line-height: 1.6; max-width: 640px; }
.ph-lead-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.ph-pill { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ptext2); border: 1px solid var(--pborder); border-radius: 5px; padding: 2px 8px; }
.ph-pill.hb { color: var(--pacc); border-color: var(--pacc-line); background: var(--pacc-soft); }
.ph-sec { margin-bottom: 30px; }
.ph-sec-h { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.ph-sec-h h3 { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; margin: 0; color: var(--ptext); }
.ph-cnt { font-family: var(--pmono); font-size: 11px; color: var(--ptext3); }
.ph-row { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; border: 1px solid var(--pborder-soft); border-radius: 11px; background: var(--psurface); margin-bottom: 8px; cursor: pointer; }
.ph-row:hover { border-color: var(--pborder); }
.ph-row.sel { border-color: var(--pacc-line); background: var(--pacc-soft); }
.ph-mark { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
.ph-mark.hi { background: var(--pacc); }
.ph-mark.wait { background: var(--pamber); }
.ph-mark.gray { background: var(--ptext3); }
.ph-rbody { flex: 1; min-width: 0; }
.ph-t { font-size: 14.5px; font-weight: 500; color: var(--ptext); line-height: 1.4; }
.ph-m { font-family: var(--pmono); font-size: 11px; color: var(--ptext3); margin-top: 8px; text-transform: uppercase; letter-spacing: 0.06em; }
.ph-tag { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ptext3); border: 1px solid var(--pborder); border-radius: 5px; padding: 3px 8px; white-space: nowrap; align-self: flex-start; }
.ph-tag.wait { color: var(--pamber); border-color: rgba(201, 154, 84, 0.35); }

/* drag-to-reorder affordances */
.ph-row { cursor: pointer; }
.ph-row:active { cursor: grabbing; }
.ph-grip { color: var(--ptext3); font-size: 12px; margin-top: 3px; cursor: grab; opacity: 0; transition: opacity 0.12s ease; flex-shrink: 0; user-select: none; }
.ph-row:hover .ph-grip { opacity: 0.6; }
.ph-row.drop { border-color: var(--pacc); box-shadow: inset 0 2px 0 var(--pacc); }
.ph-drag { color: var(--ptext3); font-size: 12px; cursor: grab; user-select: none; opacity: 0.5; margin-right: 2px; }
.ph-drag:hover { opacity: 1; color: var(--ptext2); }
.ph-sec.drop-epic { outline: 1px dashed var(--pacc-line); outline-offset: 6px; border-radius: 8px; }
.ph-dropzone { border: 1px dashed var(--pborder); border-radius: 9px; text-align: center; padding: 12px; }

/* board */
.ph-cols { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.ph-col { border: 1px solid transparent; border-radius: 12px; padding: 6px; min-height: 120px; transition: background 0.12s ease, border-color 0.12s ease; }
.ph-col.drop-col { border-color: var(--pacc-line); background: var(--pacc-soft); }
.ph-card[draggable="true"] { cursor: grab; }
.ph-card[draggable="true"]:active { cursor: grabbing; }
.ph-colh { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 12px; font-weight: 600; color: var(--ptext2); }
.ph-lane-action { border: 0; background: transparent; color: var(--ptext3); font: 9px var(--pmono); cursor: pointer; padding: 2px; text-transform: uppercase; }
.ph-lane-action:hover, .ph-lane-action:focus-visible { color: var(--pacc); outline: none; }
.ph-cd { width: 7px; height: 7px; border-radius: 50%; }
.ph-n { font-family: var(--pmono); font-size: 11px; color: var(--ptext3); }
.ph-card { background: var(--psurface); border: 1px solid var(--pborder-soft); border-radius: 10px; padding: 12px 13px; margin-bottom: 9px; cursor: pointer; }
.ph-card:hover { border-color: var(--pborder); }
.ph-card.ghost { border-style: dashed; background: transparent; cursor: default; }
.ph-ct { font-size: 13px; font-weight: 500; line-height: 1.4; color: var(--ptext); }
.ph-card.ghost .ph-ct { color: var(--ptext3); font-weight: 400; font-size: 12.5px; }
.ph-cm { font-family: var(--pmono); font-size: 10.5px; color: var(--ptext3); margin-top: 8px; text-transform: uppercase; letter-spacing: 0.06em; }

/* activity */
.ph-activity-lead { margin-bottom: 18px; }
.ph-timeline { display: flex; flex-direction: column; position: relative; }
.ph-timeline::before { content: ''; position: absolute; top: 7px; bottom: 7px; left: 6px; width: 1px; background: var(--pborder); }
.ph-activity { display: grid; grid-template-columns: 13px minmax(0, 1fr) auto; gap: 14px; width: 100%; text-align: left; background: transparent; border: none; color: inherit; padding: 0 0 18px; cursor: pointer; }
.ph-activity:hover .ph-activity-task { color: var(--pacc); }
.ph-activity-dot { width: 13px; height: 13px; border-radius: 50%; margin-top: 5px; background: var(--ptext3); border: 3px solid var(--pbg); position: relative; z-index: 1; }
.ph-activity-dot.heartbeat { background: var(--pacc); box-shadow: 0 0 0 3px var(--pacc-soft); }
.ph-activity-dot.sulla { background: var(--ptext2); }
.ph-activity-dot.human { background: var(--pgreen); }
.ph-activity-dot.workbench { background: var(--pamber); }
.ph-activity-dot.event { background: var(--pbg); border-color: var(--ptext3); }
.ph-activity-kind { display: inline-block; padding: 1px 6px; border-radius: 4px; background: var(--psurf2); color: var(--ptext2); border: 1px solid var(--pborder); font-weight: 600; letter-spacing: 0.05em; }
.ph-activity-kind.k-comment { background: var(--pacc-soft); color: var(--pacc); border-color: transparent; }
.ph-activity-kind.k-task_created, .ph-activity-kind.k-epic_created, .ph-activity-kind.k-project_created { color: var(--pgreen); }
.ph-activity.is-event .ph-activity-text { color: var(--ptext3); font-style: italic; }
.ph-activity-body { min-width: 0; display: flex; flex-direction: column; gap: 5px; padding-bottom: 2px; }
.ph-activity-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-family: var(--pmono); font-size: 10.5px; color: var(--ptext3); text-transform: uppercase; letter-spacing: 0.06em; }
.ph-activity-actor { display: inline-flex; align-items: center; min-height: 18px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--pborder); background: var(--psurf2); color: var(--ptext2); font-weight: 700; }
.ph-activity-actor.heartbeat { color: var(--pacc); background: var(--pacc-soft); border-color: var(--pacc-line); }
.ph-activity-actor.sulla { color: var(--ptext); }
.ph-activity-actor.human { color: var(--pgreen); border-color: color-mix(in srgb, var(--pgreen) 45%, transparent); }
.ph-activity-actor.workbench { color: var(--pamber); border-color: color-mix(in srgb, var(--pamber) 45%, transparent); }
.ph-activity-task { display: block; color: var(--ptext); font-size: 14px; font-weight: 600; line-height: 1.4; transition: color 0.12s ease; }
.ph-activity-text { display: -webkit-box; max-width: 780px; overflow: hidden; color: var(--ptext2); font-size: 13px; line-height: 1.55; white-space: pre-wrap; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }

/* projects overview */
.ph-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.ph-pcard { border: 1px solid var(--pborder); border-radius: 13px; padding: 20px 22px; background: var(--psurface); cursor: pointer; }
.ph-pcard:hover { border-color: var(--pacc-line); }
.ph-lane { display: inline-block; font-family: var(--pmono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; padding: 3px 9px; border-radius: 5px; border: 1px solid var(--pborder); color: var(--ptext2); margin-bottom: 12px; }
.ph-lane.hb { color: var(--pacc); border-color: var(--pacc-line); background: var(--pacc-soft); }
.ph-pcard h3 { font-family: var(--pserif); font-weight: 500; font-size: 21px; margin: 0 0 10px; color: var(--ptext); }
.ph-pcard p { font-size: 13px; color: var(--ptext2); line-height: 1.6; margin: 0 0 18px; }
.ph-prog { height: 6px; border-radius: 4px; background: var(--psurface2); overflow: hidden; margin-bottom: 12px; }
.ph-prog > i { display: block; height: 100%; background: var(--pacc); }
.ph-prog.amber > i { background: var(--pamber); }
.ph-prog.gray > i { background: var(--ptext3); }
.ph-nums { display: flex; gap: 22px; font-size: 13px; color: var(--ptext3); }
.ph-nums b { color: var(--ptext); font-weight: 600; font-family: var(--pmono); }

/* forms */
.ph-fl { display: block; font-family: var(--pmono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ptext3); margin: 12px 0 5px; }
.ph-in { width: 100%; background: var(--psurface2); border: 1px solid var(--pborder); border-radius: 7px; color: var(--ptext); font-family: var(--psans); font-size: 13px; padding: 8px 10px; }
.ph-in:focus { outline: none; border-color: var(--pacc-line); }
.ph-ta { resize: vertical; line-height: 1.5; }
.ph-frow { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

/* drawer */
.ph-scrim { position: absolute; inset: 0; background: rgba(4, 7, 12, 0.55); z-index: 20; }
.ph-scrim.center { display: flex; align-items: center; justify-content: center; }
.ph-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: 380px; background: var(--psurface); border-left: 1px solid var(--pborder); z-index: 21; display: flex; flex-direction: column; box-shadow: -20px 0 50px rgba(0, 0, 0, 0.4); }
.ph-dh { display: flex; align-items: center; padding: 16px 18px 12px; border-bottom: 1px solid var(--pborder-soft); }
.ph-dh-id { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.12em; color: var(--ptext3); flex: 1; }
.ph-x { background: transparent; border: none; color: var(--ptext3); font-size: 15px; cursor: pointer; }
.ph-x:hover { color: var(--ptext); }
.ph-db { flex: 1; overflow: auto; padding: 6px 18px 22px; }
.ph-dactions { display: flex; gap: 8px; margin-top: 18px; }
.ph-cmt-h { font-family: var(--pmono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ptext3); margin: 22px 0 10px; border-top: 1px solid var(--pborder-soft); padding-top: 16px; }
.ph-cmt-h span { color: var(--ptext2); }
.ph-cmt { border-left: 2px solid var(--pacc-line); padding: 4px 0 4px 10px; margin-bottom: 10px; }
.ph-cmt-who { font-family: var(--pmono); font-size: 10px; color: var(--pacc); margin-bottom: 3px; }
.ph-cmt-b { font-size: 12.5px; color: var(--ptext2); line-height: 1.5; white-space: pre-wrap; }
.ph-cmt-add { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.ph-cmt-add .ph-btn { align-self: flex-end; }

/* modal */
.ph-modal { width: 460px; max-width: calc(100% - 40px); max-height: calc(100% - 60px); overflow: auto; background: var(--psurface); border: 1px solid var(--pborder); border-radius: 14px; padding: 22px 24px 24px; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5); }
.ph-modal h2 { font-family: var(--pserif); font-weight: 500; font-size: 22px; margin: 0 0 6px; color: var(--ptext); }
</style>
