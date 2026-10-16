<template>
  <ProjectTableV2
    v-if="view === 'table'"
    :project-id="projectId"
    @open-card="$emit('open-card', $event)"
    @back-to-list="$emit('back-to-list')"
    @view-change="view = $event"
  />
  <section
    v-else
    class="pbv2"
  >
    <ProjectViewHeaderV2
      :title="project?.title || 'Project'"
      :meta="projectMeta"
      active-view="board"
      :can-add="Boolean(lanes.length)"
      @back-to-list="$emit('back-to-list')"
      @add-card="startAdd(lanes[0]?.lane_key)"
      @view-change="view = $event"
    />

    <div
      v-if="error || mutationError"
      class="pbv2-state error"
      role="alert"
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
      class="pbv2-state"
    >
      Loading project…
    </div>
    <div
      v-else-if="!project"
      class="pbv2-state"
    >
      Project not found.
    </div>
    <template v-else>
      <div
        class="board"
        :aria-label="`${project.title} board`"
      >
        <section
          v-for="lane in lanes"
          :key="lane.lane_key"
          class="lane"
          :class="{ over: dragOverLane === lane.lane_key }"
          @dragover.prevent="onDragOver(lane.lane_key, $event)"
          @dragleave="onDragLeave(lane.lane_key, $event)"
          @drop.prevent="onDrop(lane.lane_key)"
        >
          <header class="lane-header">
            <span
              class="lane-dot"
              :style="laneDotStyle(lane)"
            />
            <span>{{ lane.display_name }}</span>
            <span class="lane-count">{{ cardsForLane(lane.lane_key).length }}</span>
            <button
              type="button"
              class="lane-add"
              :aria-label="`Add a card to ${lane.display_name}`"
              @click="startAdd(lane.lane_key)"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
              ><path d="M12 5v14M5 12h14" /></svg>
            </button>
          </header>

          <div class="cards">
            <article
              v-for="card in cardsForLane(lane.lane_key)"
              :key="card.task.id"
              class="card"
              :class="{ dragging: draggedId === card.task.id, done: isTerminalTask(card.task), waiting: waitingOnHuman(card) }"
              draggable="true"
              role="button"
              tabindex="0"
              @click="openCard(card.task.id)"
              @keydown.enter="$emit('open-card', card.task.id)"
              @dragstart="onDragStart(card.task.id, card.task.status, $event)"
              @dragend="onDragEnd"
            >
              <div class="card-top">
                <span class="task-id">#{{ displayId(card.task) }}</span>
                <span
                  v-for="label in card.task.labels || []"
                  :key="label"
                  class="label"
                  :class="labelTone(label)"
                ><i />{{ label }}</span>
              </div>
              <div class="card-title">
                {{ card.task.title }}
              </div>

              <div
                v-if="waitingOnHuman(card)"
                class="work-strip waiting-strip"
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
              </div>

              <footer class="card-footer">
                <span
                  v-if="card.subtasks.length"
                  :class="{ complete: card.checklistDone === card.subtasks.length }"
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
                <span
                  v-if="card.task.due_at"
                  class="due"
                  :class="dueState(card.task.due_at)"
                  title="Due date"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.9"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  ><rect
                    x="4"
                    y="5"
                    width="16"
                    height="15"
                    rx="2.5"
                  /><path d="M4 10h16M8 3v4M16 3v4" /></svg>
                  {{ dueLabel(card.task.due_at) }}
                </span>
                <a
                  v-if="linkedPullRequest(card.task)?.href"
                  class="pr"
                  :href="linkedPullRequest(card.task)!.href"
                  target="_blank"
                  rel="noreferrer"
                  title="Linked pull request"
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
                  class="pr"
                  title="Linked pull request"
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
                  v-if="card.task.assignee"
                  class="assignee"
                  :title="assigneeName(card.task.assignee)"
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
                </span>
              </footer>
            </article>
          </div>

          <div
            v-if="composerLane === lane.lane_key"
            class="composer"
          >
            <textarea
              ref="composerInput"
              v-model="newTitle"
              rows="2"
              placeholder="Card title…"
              @keydown.enter.exact.prevent="saveCard(lane.lane_key)"
              @keydown.esc="cancelAdd"
            />
            <div class="composer-actions">
              <button
                type="button"
                class="save"
                :disabled="!newTitle.trim()"
                @click="saveCard(lane.lane_key)"
              >
                Add card
              </button>
              <button
                type="button"
                @click="cancelAdd"
              >
                Cancel
              </button>
            </div>
          </div>
          <button
            v-else
            type="button"
            class="add-card"
            @click="startAdd(lane.lane_key)"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
            ><path d="M12 5v14M5 12h14" /></svg>
            Add a card
          </button>
        </section>
      </div>
      <div class="legend">
        <span>Drag a card to move it</span><i />
        <span>Click a card to open it</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';

import ProjectTableV2 from './ProjectTableV2.vue';
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

const {
  project,
  lanes,
  cards,
  isLoading,
  error,
  mutationError,
  refresh,
  addCard,
  moveCard,
  assigneeName,
  isAgentAssignee,
  waitingOnHuman,
} = useProjectViewV2(() => props.projectId);

const view = ref<'board' | 'table'>('board');
const composerLane = ref('');
const newTitle = ref('');
const composerInput = ref<HTMLTextAreaElement | null>(null);
const draggedId = ref('');
const draggedStatus = ref('');
const dragOverLane = ref('');
const suppressOpen = ref(false);
const projectMeta = computed(() => {
  if (!project.value) return '';
  const open = cards.value.filter(card => !isTerminalTask(card.task)).length;

  return `${ cards.value.length } cards · ${ open } open`;
});

function cardsForLane(laneKey: string) {
  return cards.value.filter(card => card.task.status === laneKey);
}

function startAdd(laneKey?: string): void {
  if (!laneKey) return;
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

function onDragStart(taskId: string, status: string, event: DragEvent): void {
  draggedId.value = taskId;
  draggedStatus.value = status;
  suppressOpen.value = true;
  event.dataTransfer?.setData('text/plain', taskId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDragOver(laneKey: string, event: DragEvent): void {
  if (!draggedId.value) return;
  dragOverLane.value = laneKey;
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
}

function onDragLeave(laneKey: string, event: DragEvent): void {
  const target = event.currentTarget as HTMLElement;
  if (dragOverLane.value === laneKey && !target.contains(event.relatedTarget as Node | null)) dragOverLane.value = '';
}

async function onDrop(laneKey: string): Promise<void> {
  const taskId = draggedId.value;
  const changed = taskId && draggedStatus.value !== laneKey;
  onDragEnd();
  if (changed) await moveCard(taskId, laneKey);
}

function onDragEnd(): void {
  draggedId.value = '';
  draggedStatus.value = '';
  dragOverLane.value = '';
  window.setTimeout(() => { suppressOpen.value = false }, 0);
}

function openCard(taskId: string): void {
  if (!suppressOpen.value) emit('open-card', taskId);
}

const emit = defineEmits<{
  (event: 'open-card', taskId: string): void;
  (event: 'back-to-list'): void;
}>();

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
.pbv2 { --v2-text: var(--text, #1a2332); --v2-muted: var(--text-muted, #5b6778); --v2-dim: var(--text-dim, #8a94a3); --v2-card: var(--surface-1, #fff); --v2-soft: var(--surface-2, #eaf0f6); min-width: 0; padding: 16px 20px 60px; color: var(--v2-text); font-family: var(--font-body, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif); }
.board { display: grid; grid-auto-columns: minmax(220px, 1fr); grid-auto-flow: column; gap: 12px; align-items: start; min-height: 60vh; padding-bottom: 8px; overflow-x: auto; }
.lane { display: flex; min-height: 120px; flex-direction: column; border: 1px solid var(--border, rgba(26,35,50,.09)); border-radius: 12px; background: color-mix(in srgb, var(--v2-text) 3.5%, transparent); transition: background .12s, border-color .12s; }
.lane.over { border-color: color-mix(in srgb, var(--accent, #3a7fa0) 35%, transparent); background: color-mix(in srgb, var(--accent, #3a7fa0) 11%, transparent); }
.lane-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.lane-dot { width: 8px; height: 8px; flex: none; border-radius: 50%; }
.lane-count { padding: 0 7px; border: 1px solid var(--border, rgba(26,35,50,.09)); border-radius: 999px; color: var(--v2-muted); background: color-mix(in srgb, var(--v2-card) 75%, transparent); font-size: 11px; line-height: 17px; }
.lane-add { width: 24px; height: 24px; display: grid; place-items: center; margin-left: auto; padding: 0; border: 0; border-radius: 6px; color: var(--v2-dim); background: transparent; cursor: pointer; opacity: 0; }
.lane:hover .lane-add { opacity: 1; }
.lane-add:hover { color: var(--v2-text); background: color-mix(in srgb, var(--v2-text) 6%, transparent); }
.lane-add svg { width: 14px; }
.cards { display: flex; flex-direction: column; gap: 8px; min-height: 24px; padding: 2px 8px 8px; }
.card { position: relative; padding: 10px 11px 9px; border: 1px solid var(--border, rgba(26,35,50,.09)); border-radius: 10px; background: var(--v2-card); box-shadow: 0 1px 1px rgba(26,35,50,.04), 0 2px 8px -2px rgba(26,35,50,.08); cursor: grab; animation: rise .18s ease-out; }
.card:hover { border-color: color-mix(in srgb, var(--accent, #3a7fa0) 35%, transparent); box-shadow: 0 1px 2px rgba(26,35,50,.04), 0 10px 30px -12px rgba(26,35,50,.12); }
.card:focus-visible { outline: 2px solid var(--accent, #3a7fa0); outline-offset: 2px; }
.card.dragging { opacity: .45; transform: rotate(1.2deg); }
.card.done { opacity: .72; }
.card.done .card-title { color: var(--v2-muted); }
.card.waiting { border-color: rgba(217,138,10,.32); }
.card-top { display: flex; min-height: 16px; flex-wrap: wrap; gap: 5px; align-items: center; margin-bottom: 5px; }
.task-id { color: var(--v2-dim); font-family: var(--font-mono, ui-monospace, monospace); font-size: 10.5px; }
.card-title { color: var(--v2-text); font-size: 12.8px; font-weight: 500; line-height: 1.38; }
.label { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; line-height: 16px; white-space: nowrap; }
.label i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .8; }
.tone-0 { color: #b1302b; background: rgba(217,64,58,.11); } .tone-1 { color: #5a3fb0; background: rgba(107,79,191,.12); } .tone-2 { color: var(--accent, #2f6a86); background: color-mix(in srgb, var(--accent, #3a7fa0) 11%, transparent); } .tone-3 { color: #9a6207; background: rgba(217,138,10,.13); } .tone-4 { color: #167a42; background: rgba(31,157,85,.12); }
.work-strip { display: flex; align-items: center; gap: 7px; margin-top: 8px; padding: 6px 8px; border-radius: 7px; font-size: 11.5px; font-weight: 600; line-height: 1.3; }
.work-strip svg { width: 13px; height: 13px; flex: none; }
.waiting-strip { color: #9a6207; background: rgba(217,138,10,.13); }
.card-footer { display: flex; align-items: center; gap: 9px; min-height: 20px; margin-top: 9px; color: var(--v2-dim); font-size: 11.5px; }
.card-footer > span, .card-footer > a { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.card-footer svg { width: 13px; height: 13px; }
.card-footer .complete { color: #167a42; }
.due.soon { color: #9a6207; } .due.overdue { color: #d9403a; }
.pr { color: var(--accent, #3a7fa0); text-decoration: none; }
.assignee { margin-left: auto; }
.avatar { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; color: #fff; background: linear-gradient(135deg, #9ec1d3, #3a7fa0); font-size: 8px; font-weight: 700; }
.avatar.agent { border-radius: 6px; background: linear-gradient(135deg, #1a2332, #3a7fa0); }
.avatar svg { width: 11px; height: 11px; }
.add-card { display: flex; align-items: center; gap: 6px; margin: 0 8px 8px; padding: 7px 9px; border: 1px dashed transparent; border-radius: 8px; color: var(--v2-muted); background: transparent; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
.add-card:hover { border-color: var(--border, rgba(26,35,50,.14)); color: var(--v2-text); background: color-mix(in srgb, var(--v2-card) 70%, transparent); }
.add-card svg { width: 13px; }
.composer { margin: 0 8px 8px; padding: 9px 10px 8px; border: 1px solid color-mix(in srgb, var(--accent, #3a7fa0) 35%, transparent); border-radius: 10px; background: var(--v2-card); box-shadow: 0 1px 2px rgba(26,35,50,.04), 0 10px 30px -12px rgba(26,35,50,.12); }
.composer textarea { width: 100%; min-height: 40px; padding: 0; resize: none; border: 0; outline: 0; color: var(--v2-text); background: transparent; font: inherit; font-size: 12.8px; line-height: 1.4; }
.composer-actions { display: flex; gap: 6px; margin-top: 6px; }
.composer-actions button, .pbv2-state button { padding: 4px 8px; border: 1px solid var(--border, rgba(26,35,50,.14)); border-radius: 6px; color: var(--v2-text); background: var(--v2-card); font: inherit; font-size: 11.5px; cursor: pointer; }
.composer-actions .save { border-color: var(--accent, #3a7fa0); color: #fff; background: var(--accent, #3a7fa0); }
.composer-actions .save:disabled { opacity: .45; cursor: default; }
.legend { display: flex; align-items: center; gap: 10px; margin: 12px 2px 0; color: var(--v2-dim); font-size: 11.5px; }
.legend i { width: 3px; height: 3px; border-radius: 50%; background: var(--v2-dim); }
.pbv2-state { padding: 36px; border: 1px solid var(--border, rgba(26,35,50,.09)); border-radius: 12px; color: var(--v2-muted); text-align: center; background: var(--v2-card); }
.pbv2-state.error { color: #b1302b; }
.pbv2-state button { margin-left: 8px; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (max-width: 900px) { .board { grid-auto-columns: minmax(240px, 260px); } }
@media (max-width: 700px) { .pbv2 { padding: 12px; } }
</style>
