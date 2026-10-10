<template>
  <section
    class="dependency-graph"
    aria-labelledby="dependency-graph-title"
  >
    <header class="dg-head">
      <div>
        <h2 id="dependency-graph-title">
          Dependency graph
        </h2>
        <p>Live task readiness from the same dependency gate used by autonomous claims.</p>
      </div>
      <button
        type="button"
        :disabled="loading"
        @click="reload"
      >
        {{ loading ? 'Loading…' : 'Refresh' }}
      </button>
    </header>

    <div
      v-if="failure"
      class="dg-error"
      role="alert"
    >
      {{ failure }}
    </div>
    <div
      class="dg-summary"
      aria-label="Dependency readiness summary"
    >
      <span><b>{{ readyCount }}</b> ready</span>
      <span><b>{{ blockedCount }}</b> dependency-held</span>
      <span><b>{{ dependencies.length }}</b> edges</span>
    </div>

    <div
      v-if="!loading && !tasks.length"
      class="dg-empty"
    >
      No tasks in this project.
    </div>
    <div
      v-else
      class="dg-epics"
    >
      <section
        v-for="epic in project.epics"
        :key="epic.id"
        class="dg-epic"
      >
        <header>
          <h3>{{ epic.title }}</h3>
          <span>{{ epic.tasks.length }} task{{ epic.tasks.length === 1 ? '' : 's' }}</span>
        </header>
        <div class="dg-nodes">
          <button
            v-for="task in epic.tasks"
            :key="task.id"
            type="button"
            class="dg-node"
            :class="readinessClass(task.id)"
            @click="emit('openTask', task)"
          >
            <span class="dg-node-state">{{ readinessLabel(task.id) }}</span>
            <strong>{{ task.title }}</strong>
            <small>{{ task.status }} · {{ task.id }}</small>
            <span
              v-for="edge in incoming(task.id)"
              :key="edge.depends_on_task_id"
              class="dg-edge"
            >
              <span aria-hidden="true">←</span>
              {{ taskTitle(edge.depends_on_task_id) }}
              <em>{{ edge.relation_type }}</em>
            </span>
            <span
              v-if="!incoming(task.id).length"
              class="dg-root"
            >No prerequisites</span>
          </button>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { TaskDependencyHold } from '@pkg/agent/database/models/WorkTaskDependencyModel';
import { useProjects, type ProjectView, type TaskView, type WorkTaskDependencyRecord } from '@pkg/composables/useProjects';

const props = defineProps<{ project: ProjectView }>();
const emit = defineEmits<{ openTask: [task: TaskView] }>();
const { listTaskDependencies, listReadyTasks } = useProjects();

const dependencies = ref<WorkTaskDependencyRecord[]>([]);
const readyIds = ref(new Set<string>());
const blockedHolds = ref(new Map<string, TaskDependencyHold[]>());
const loading = ref(false);
const failure = ref('');

const tasks = computed(() => props.project.epics.flatMap(epic => epic.tasks));
const taskById = computed(() => new Map(tasks.value.map(task => [task.id, task])));
const readyCount = computed(() => readyIds.value.size);
const blockedCount = computed(() => blockedHolds.value.size);

async function reload(): Promise<void> {
  loading.value = true;
  failure.value = '';
  try {
    const [edges, readiness] = await Promise.all([
      listTaskDependencies(props.project.id),
      listReadyTasks(props.project.id),
    ]);
    dependencies.value = edges.filter(edge => !edge.archived);
    readyIds.value = new Set(readiness.ready.map(task => task.id));
    blockedHolds.value = new Map(readiness.blocked.map(entry => [entry.task.id, entry.holds]));
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

function incoming(taskId: string): WorkTaskDependencyRecord[] {
  return dependencies.value.filter(edge => edge.task_id === taskId);
}

function taskTitle(taskId: string): string {
  return taskById.value.get(taskId)?.title ?? taskId;
}

function readinessLabel(taskId: string): string {
  const task = taskById.value.get(taskId);
  if (task?.lane?.semantic_role === 'terminal' || ['done', 'cancelled', 'parked'].includes(task?.status ?? '')) return 'Closed';
  const holds = blockedHolds.value.get(taskId);
  if (holds?.length) return `Blocked · ${ holds.length }`;
  if (readyIds.value.has(taskId)) return 'Ready';
  return 'Not claimable';
}

function readinessClass(taskId: string): string {
  const label = readinessLabel(taskId);
  return label === 'Ready' ? 'ready' : label.startsWith('Blocked') ? 'blocked' : label === 'Closed' ? 'closed' : 'held';
}

watch(() => props.project.id, () => { reload().catch(() => undefined) }, { immediate: true });
</script>

<style scoped>
.dependency-graph { color: var(--ptext); }
.dg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
.dg-head h2, .dg-epic h3 { margin: 0; font-family: var(--pserif); font-weight: 500; }
.dg-head p { margin: 5px 0 0; color: var(--ptext2); font-size: 12px; }
.dg-head button { border: 1px solid var(--pborder); border-radius: 7px; background: transparent; color: var(--ptext2); padding: 7px 10px; cursor: pointer; }
.dg-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
.dg-summary span { border: 1px solid var(--pborder); border-radius: 7px; background: var(--psurface2); color: var(--ptext2); padding: 7px 10px; font-size: 11px; }
.dg-summary b { color: var(--ptext); font-family: var(--pmono); }
.dg-error, .dg-empty { padding: 12px; border-radius: 8px; color: var(--ptext2); background: var(--psurface2); }
.dg-error { color: var(--pred); background: rgba(201,115,111,.1); }
.dg-epics { display: grid; gap: 18px; }
.dg-epic { border-top: 1px solid var(--pborder); padding-top: 14px; }
.dg-epic > header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.dg-epic > header span { color: var(--ptext3); font: 10px var(--pmono); }
.dg-nodes { display: grid; grid-template-columns: repeat(auto-fill, minmax(235px, 1fr)); gap: 9px; }
.dg-node { display: grid; gap: 5px; min-width: 0; text-align: left; border: 1px solid var(--pborder); border-left: 3px solid var(--ptext3); border-radius: 9px; background: var(--psurface); color: var(--ptext); padding: 12px; cursor: pointer; }
.dg-node.ready { border-left-color: var(--pgreen); }.dg-node.blocked { border-left-color: var(--pamber); }.dg-node.closed { opacity: .62; }
.dg-node:hover { border-color: var(--pacc-line); }
.dg-node-state { color: var(--ptext3); font: 9px var(--pmono); text-transform: uppercase; letter-spacing: .08em; }
.dg-node.ready .dg-node-state { color: var(--pgreen); }.dg-node.blocked .dg-node-state { color: var(--pamber); }
.dg-node strong { overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
.dg-node small { color: var(--ptext3); font: 9px var(--pmono); }
.dg-edge { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 5px; margin-top: 3px; border-radius: 5px; background: var(--psurface2); color: var(--ptext2); padding: 5px 6px; font-size: 10px; }
.dg-edge em { color: var(--ptext3); font: 8px var(--pmono); }
.dg-root { color: var(--ptext3); font-size: 10px; }

:global(.theme-noir-dark) .dg-head h2 { color: #f3f5f8; font-size: 30px; font-weight: 600; }
:global(.theme-noir-dark) .dg-head p { color: #a9b3c1; font-size: 13px; }
:global(.theme-noir-dark) .dg-head button { border-color: rgba(168,192,220,.1); border-radius: 999px; transition: transform .45s var(--noir-spring),background .16s ease,border-color .16s ease; }
:global(.theme-noir-dark) .dg-head button:hover:not(:disabled) { border-color: rgba(106,176,204,.35); background: rgba(80,150,179,.08); transform: translateY(-1px); }
:global(.theme-noir-dark) .dg-summary span { min-width: 112px; border-color: rgba(168,192,220,.08); border-radius: 14px; background: rgba(168,192,220,.035); color: #7a8291; font: 10px var(--pmono); text-transform: uppercase; }
:global(.theme-noir-dark) .dg-summary b { display: inline-block; margin-right: 4px; color: #f3f5f8; font: 600 22px var(--pserif); }
:global(.theme-noir-dark) .dg-epic { border-color: rgba(168,192,220,.08); }
:global(.theme-noir-dark) .dg-epic h3 { color: #dee4ec; font-size: 20px; }
:global(.theme-noir-dark) .dg-nodes { gap: 12px; }
:global(.theme-noir-dark) .dg-node {
  position: relative;
  overflow: hidden;
  border-color: rgba(168,192,220,.08);
  border-left-color: #5096b3;
  border-radius: 15px;
  background: linear-gradient(160deg,rgba(80,150,179,.055),rgba(168,192,220,.018));
  box-shadow: inset 0 1px 0 rgba(168,192,220,.03);
  transition: transform .5s var(--noir-spring),border-color .16s ease,box-shadow .18s ease,background .16s ease;
}
:global(.theme-noir-dark) .dg-node:hover {
  border-color: rgba(106,176,204,.42);
  border-left-color: #6ab0cc;
  background: rgba(80,150,179,.08);
  box-shadow: 0 0 24px rgba(80,150,179,.14),0 15px 34px rgba(0,0,0,.24);
  transform: translateY(-3px);
}
:global(.theme-noir-dark) .dg-node.ready { border-left-color: #3fb950; }
:global(.theme-noir-dark) .dg-node.blocked { border-left-color: #e3b341; }
:global(.theme-noir-dark) .dg-edge { border: 1px solid rgba(106,176,204,.08); border-radius: 9px; background: rgba(3,6,12,.62); }
:global(.theme-noir-dark) .dg-edge > span:first-child { color: #6ab0cc; text-shadow: 0 0 8px rgba(106,176,204,.7); }
@media (prefers-reduced-motion: reduce) { :global(.theme-noir-dark) .dg-node, :global(.theme-noir-dark) .dg-head button { transition: none; } }
</style>
