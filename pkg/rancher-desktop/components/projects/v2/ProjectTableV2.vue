<template>
  <section class="ptv2">
    <ProjectViewHeaderV2
      :title="project?.title || 'Project'"
      :meta="projectMeta"
      active-view="table"
      :can-add="Boolean(lanes.length)"
      @back-to-list="$emit('back-to-list')"
      @add-card="startAdd(lanes[0]?.lane_key)"
      @view-change="$emit('view-change', $event)"
    />

    <div
      v-if="error || mutationError"
      class="ptv2-state error"
    >
      {{ mutationError || error }}
      <button
        type="button"
        @click="refresh"
      >
        Try again
      </button>
    </div>
    <div
      v-else-if="isLoading && !project"
      class="ptv2-state"
    >
      Loading project…
    </div>
    <div
      v-else-if="!project"
      class="ptv2-state"
    >
      Project not found.
    </div>
    <div
      v-else
      class="ptv2-shell"
    >
      <div
        class="ptv2-scroll"
        role="region"
        :aria-label="`${project.title} task table`"
        tabindex="0"
      >
        <table>
          <thead>
            <tr>
              <th class="title-col">
                Title
              </th>
              <th>Status</th>
              <th>Assignee</th>
              <th class="labels-col">
                Labels
              </th>
              <th class="due-col">
                Due
              </th>
              <th class="linked-col">
                Linked
              </th>
            </tr>
          </thead>
          <tbody>
            <template
              v-for="group in groups"
              :key="group.lane.lane_key"
            >
              <tr
                class="group-row"
                :class="{ closed: collapsed.has(group.lane.lane_key) }"
                @click="toggleGroup(group.lane.lane_key)"
              >
                <td colspan="6">
                  <div class="group-content">
                    <span
                      class="chevron"
                      aria-hidden="true"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      ><path d="M7 10l5 5 5-5" /></svg>
                    </span>
                    <span
                      class="lane-dot"
                      :style="laneDotStyle(group.lane)"
                    />
                    {{ group.lane.display_name }}
                    <span class="count">{{ group.cards.length }}</span>
                    <span
                      v-if="collapsed.has(group.lane.lane_key) && group.cards.length"
                      class="hidden-count"
                    >{{ group.cards.length }} hidden</span>
                    <span class="group-spacer" />
                    <button
                      type="button"
                      class="small-add"
                      @click.stop="startAdd(group.lane.lane_key)"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                      ><path d="M12 5v14M5 12h14" /></svg>
                      Add
                    </button>
                  </div>
                </td>
              </tr>
              <template v-if="!collapsed.has(group.lane.lane_key)">
                <tr
                  v-for="card in group.cards"
                  :key="card.task.id"
                  class="task-row"
                  :class="{ done: isTerminalTask(card.task) }"
                  tabindex="0"
                  @click="$emit('open-card', card.task.id)"
                  @keydown.enter="$emit('open-card', card.task.id)"
                >
                  <td>
                    <div class="task-title">
                      <span class="task-id">#{{ displayId(card.task) }}</span>
                      <span class="task-copy">{{ card.task.title }}</span>
                      <span
                        v-if="card.subtasks.length"
                        class="task-extra"
                        title="Checklist"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        ><rect
                          x="4"
                          y="4"
                          width="16"
                          height="16"
                          rx="3"
                        /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></svg>
                        {{ card.checklistDone }}/{{ card.subtasks.length }}
                      </span>
                      <span
                        v-if="card.commentCount"
                        class="task-extra"
                        title="Comments"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.9"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        ><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z" /></svg>
                        {{ card.commentCount }}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span
                      v-if="card.activeAgent"
                      class="status-pill working"
                    >
                      <span class="agent-pulse" />
                      {{ card.activeAgent }} is working
                    </span>
                    <span
                      v-else-if="waitingOnHuman(card)"
                      class="status-pill waiting"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                      ><circle
                        cx="12"
                        cy="12"
                        r="8.5"
                      /><path d="M12 8v4.5M12 16v.01" /></svg>
                      Waiting on {{ waitingOnHuman(card) }}
                    </span>
                    <span
                      v-else
                      class="status-pill"
                    >
                      <span
                        class="lane-dot"
                        :style="laneDotStyle(group.lane)"
                      />
                      {{ group.lane.display_name }}
                    </span>
                  </td>
                  <td>
                    <span
                      v-if="card.task.assignee"
                      class="assignee"
                    >
                      <span
                        class="avatar"
                        :class="{ agent: isAgentAssignee(card.task.assignee) }"
                      >
                        <svg
                          v-if="isAgentAssignee(card.task.assignee)"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        ><rect
                          x="4"
                          y="8"
                          width="16"
                          height="11"
                          rx="3"
                        /><path d="M12 8V4M9 4h6" /><circle
                          cx="9"
                          cy="13.5"
                          r="1.2"
                          fill="currentColor"
                          stroke="none"
                        /><circle
                          cx="15"
                          cy="13.5"
                          r="1.2"
                          fill="currentColor"
                          stroke="none"
                        /></svg>
                        <template v-else>{{ initials(card.task.assignee) }}</template>
                      </span>
                      {{ assigneeName(card.task.assignee) }}
                    </span>
                    <span
                      v-else
                      class="empty"
                    >—</span>
                  </td>
                  <td class="labels-col">
                    <div class="labels">
                      <span
                        v-for="label in card.task.labels || []"
                        :key="label"
                        class="label"
                        :class="labelTone(label)"
                      ><i />{{ label }}</span>
                    </div>
                  </td>
                  <td
                    class="due-col"
                    :class="dueState(card.task.due_at)"
                  >
                    {{ dueLabel(card.task.due_at) || '—' }}
                  </td>
                  <td class="linked-col">
                    <a
                      v-if="linkedPullRequest(card.task)?.href"
                      class="pr-link"
                      :href="linkedPullRequest(card.task)!.href"
                      target="_blank"
                      rel="noreferrer"
                      @click.stop
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.9"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      ><circle
                        cx="6"
                        cy="6"
                        r="2.5"
                      /><circle
                        cx="6"
                        cy="18"
                        r="2.5"
                      /><circle
                        cx="18"
                        cy="18"
                        r="2.5"
                      /><path d="M6 8.5v7M18 15.5V11a3 3 0 0 0-3-3h-3M14 5l-2 3 2 3" /></svg>
                      {{ linkedPullRequest(card.task)!.label }}
                    </a>
                    <span
                      v-else-if="linkedPullRequest(card.task)"
                      class="pr-link"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.9"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      ><circle
                        cx="6"
                        cy="6"
                        r="2.5"
                      /><circle
                        cx="6"
                        cy="18"
                        r="2.5"
                      /><circle
                        cx="18"
                        cy="18"
                        r="2.5"
                      /><path d="M6 8.5v7M18 15.5V11a3 3 0 0 0-3-3h-3M14 5l-2 3 2 3" /></svg>
                      {{ linkedPullRequest(card.task)!.label }}
                    </span>
                    <span
                      v-else
                      class="empty"
                    >—</span>
                  </td>
                </tr>
                <tr
                  v-if="composerLane === group.lane.lane_key"
                  class="composer-row"
                >
                  <td colspan="6">
                    <input
                      ref="composerInput"
                      v-model="newTitle"
                      :placeholder="`Card title in ${group.lane.display_name}…`"
                      @keydown.enter.prevent="saveCard(group.lane.lane_key)"
                      @keydown.esc="cancelAdd"
                    >
                    <button
                      type="button"
                      class="save"
                      :disabled="!newTitle.trim()"
                      @click="saveCard(group.lane.lane_key)"
                    >
                      Add card
                    </button>
                    <button
                      type="button"
                      class="cancel"
                      @click="cancelAdd"
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
                <tr
                  v-else
                  class="add-row"
                  @click="startAdd(group.lane.lane_key)"
                >
                  <td colspan="6">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.2"
                      stroke-linecap="round"
                    ><path d="M12 5v14M5 12h14" /></svg>
                    Add a card to {{ group.lane.display_name }}
                  </td>
                </tr>
              </template>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';

import ProjectViewHeaderV2 from './ProjectViewHeaderV2.vue';
import {
  dueLabel,
  dueState,
  isTerminalTask,
  linkedPullRequest,
  useProjectViewV2,
} from './useProjectViewV2';

import type { EffectiveWorkLane, TaskView } from '@pkg/composables/useProjects';

const props = defineProps<{ projectId: string }>();

defineEmits<{
  (event: 'open-card', taskId: string): void;
  (event: 'back-to-list'): void;
  (event: 'view-change', view: 'board' | 'table'): void;
}>();

const {
  project,
  lanes,
  cards,
  isLoading,
  error,
  mutationError,
  refresh,
  addCard,
  assigneeName,
  isAgentAssignee,
  waitingOnHuman,
} = useProjectViewV2(() => props.projectId);

const collapsed = ref(new Set<string>());
const composerLane = ref('');
const newTitle = ref('');
const composerInput = ref<HTMLInputElement | null>(null);
const groups = computed(() => lanes.value.map(lane => ({
  lane,
  cards: cards.value.filter(card => card.task.status === lane.lane_key),
})));
const projectMeta = computed(() => {
  if (!project.value) return '';
  const open = cards.value.filter(card => !isTerminalTask(card.task)).length;

  return `${ cards.value.length } cards · ${ open } open`;
});

function toggleGroup(laneKey: string): void {
  const next = new Set(collapsed.value);
  next.has(laneKey) ? next.delete(laneKey) : next.add(laneKey);
  collapsed.value = next;
}

function startAdd(laneKey?: string): void {
  if (!laneKey) return;
  const next = new Set(collapsed.value);
  next.delete(laneKey);
  collapsed.value = next;
  composerLane.value = laneKey;
  newTitle.value = '';
  nextTick(() => composerInput.value?.focus());
}

function cancelAdd(): void {
  composerLane.value = '';
  newTitle.value = '';
}

async function saveCard(laneKey: string): Promise<void> {
  const title = newTitle.value.trim();
  if (!title) return;
  if (await addCard(title, laneKey)) cancelAdd();
}

function laneDotStyle(lane: EffectiveWorkLane): Record<string, string> {
  return { background: lane.color || 'var(--accent, #3a7fa0)' };
}

function displayId(task: TaskView): string {
  return task.slug || task.id.slice(0, 4);
}

function initials(value: string): string {
  return value.split(/[\s_-]+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('');
}

function labelTone(label: string): string {
  let hash = 0;
  for (const char of label) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;

  return `tone-${ Math.abs(hash) % 5 }`;
}
</script>

<style scoped>
.ptv2 { --v2-text: var(--text, #1a2332); --v2-muted: var(--text-muted, #5b6778); --v2-dim: var(--text-dim, #8a94a3); --v2-card: var(--surface-1, #fff); --v2-soft: var(--surface-2, #eaf0f6); min-width: 0; padding: 16px 20px 60px; color: var(--v2-text); font-family: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); }
.ptv2-shell { overflow: hidden; border: 1px solid var(--border, rgba(26, 35, 50, .09)); border-radius: 12px; background: color-mix(in srgb, var(--v2-card) 86%, transparent); box-shadow: 0 1px 2px rgba(26,35,50,.04), 0 10px 30px -12px rgba(26,35,50,.12); }
.ptv2-scroll { overflow: auto; }
table { width: 100%; min-width: 860px; border-collapse: collapse; }
th { padding: 8px 12px; border-bottom: 1px solid var(--border, rgba(26,35,50,.09)); color: var(--v2-dim); font-size: 10.5px; font-weight: 600; letter-spacing: .07em; text-align: left; text-transform: uppercase; white-space: nowrap; }
td { padding: 8px 12px; border-bottom: 1px solid var(--border, rgba(26,35,50,.09)); font-size: 12.5px; vertical-align: middle; }
.title-col { width: 42%; }
.group-row { cursor: pointer; user-select: none; }
.group-row td { padding: 9px 12px; background: color-mix(in srgb, var(--v2-text) 3%, transparent); font-weight: 600; }
.group-content { display: flex; align-items: center; gap: 8px; }
.chevron { width: 18px; height: 18px; display: grid; place-items: center; color: var(--v2-dim); }
.chevron svg { width: 12px; transition: transform .15s; }
.group-row.closed .chevron svg { transform: rotate(-90deg); }
.lane-dot { width: 8px; height: 8px; display: inline-block; flex: none; border-radius: 50%; }
.count { padding: 0 7px; border: 1px solid var(--border, rgba(26,35,50,.09)); border-radius: 999px; color: var(--v2-muted); background: var(--v2-card); font-size: 11px; line-height: 17px; }
.hidden-count { color: var(--v2-dim); font-size: 11.5px; font-weight: 400; }
.group-spacer { flex: 1; }
.small-add { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border: 1px solid var(--border, rgba(26,35,50,.14)); border-radius: 6px; color: var(--v2-muted); background: var(--v2-card); font: inherit; font-size: 11px; cursor: pointer; }
.small-add svg { width: 12px; }
.task-row { cursor: pointer; }
.task-row:hover td { background: color-mix(in srgb, var(--accent, #3a7fa0) 5%, transparent); }
.task-row:focus-visible { outline: 2px solid var(--accent, #3a7fa0); outline-offset: -2px; }
.task-row.done .task-copy { color: var(--v2-muted); }
.task-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.task-id { width: 42px; flex: none; color: var(--v2-dim); font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; }
.task-copy { overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.task-extra { display: inline-flex; align-items: center; gap: 3px; flex: none; color: var(--v2-dim); font-size: 11px; white-space: nowrap; }
.task-extra svg, .status-pill svg, .pr-link svg { width: 13px; height: 13px; }
.status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; color: var(--v2-muted); background: var(--v2-soft); font-size: 11px; font-weight: 600; white-space: nowrap; }
.status-pill.working { color: var(--accent, #3a7fa0); background: color-mix(in srgb, var(--accent, #3a7fa0) 12%, transparent); }
.status-pill.waiting { color: #9a6207; background: rgba(217,138,10,.13); }
.agent-pulse { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--accent, #3a7fa0); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #3a7fa0) 14%, transparent); animation: agent-pulse 2s infinite; }
.assignee { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.avatar { width: 20px; height: 20px; display: grid; place-items: center; flex: none; border-radius: 50%; color: #fff; background: linear-gradient(135deg, #9ec1d3, #3a7fa0); font-size: 8px; font-weight: 700; }
.avatar.agent { border-radius: 6px; background: linear-gradient(135deg, #1a2332, #3a7fa0); }
.avatar svg { width: 11px; height: 11px; }
.labels { display: flex; gap: 4px; }
.label { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; line-height: 16px; white-space: nowrap; }
.label i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .8; }
.tone-0 { color: #b1302b; background: rgba(217,64,58,.11); } .tone-1 { color: #5a3fb0; background: rgba(107,79,191,.12); } .tone-2 { color: var(--accent, #2f6a86); background: color-mix(in srgb, var(--accent, #3a7fa0) 11%, transparent); } .tone-3 { color: #9a6207; background: rgba(217,138,10,.13); } .tone-4 { color: #167a42; background: rgba(31,157,85,.12); }
.due-col { white-space: nowrap; } .due-col.soon { color: #9a6207; } .due-col.overdue { color: #d9403a; }
.pr-link { display: inline-flex; align-items: center; gap: 5px; color: var(--accent, #3a7fa0); text-decoration: none; white-space: nowrap; }
.empty { color: var(--v2-dim); }
.add-row { color: var(--v2-dim); cursor: pointer; }
.add-row:hover td { color: var(--v2-text); background: color-mix(in srgb, var(--accent, #3a7fa0) 5%, transparent); }
.add-row td { display: flex; align-items: center; gap: 6px; padding: 6px 16px; }
.add-row svg { width: 13px; }
.composer-row td { display: flex; gap: 6px; padding: 8px 12px; }
.composer-row input { min-width: 180px; flex: 1; padding: 7px 9px; border: 1px solid color-mix(in srgb, var(--accent, #3a7fa0) 35%, transparent); border-radius: 8px; color: var(--v2-text); background: var(--v2-card); font: inherit; outline: 0; }
.composer-row button, .ptv2-state button { padding: 6px 9px; border: 1px solid var(--border, rgba(26,35,50,.14)); border-radius: 7px; color: var(--v2-text); background: var(--v2-card); font: inherit; cursor: pointer; }
.composer-row .save { border-color: var(--accent, #3a7fa0); color: #fff; background: var(--accent, #3a7fa0); }
.composer-row .save:disabled { opacity: .45; cursor: default; }
.ptv2-state { padding: 36px; border: 1px solid var(--border, rgba(26,35,50,.09)); border-radius: 12px; color: var(--v2-muted); text-align: center; background: var(--v2-card); }
.ptv2-state.error { color: #b1302b; }
.ptv2-state button { margin-left: 8px; }
@keyframes agent-pulse { 50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent, #3a7fa0) 5%, transparent); } }
@media (max-width: 900px) { .labels-col, .linked-col { display: none; } }
@media (max-width: 700px) { .ptv2 { padding: 12px; } .due-col { display: none; } }
</style>
