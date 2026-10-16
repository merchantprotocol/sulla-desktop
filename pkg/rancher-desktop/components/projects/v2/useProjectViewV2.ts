import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  useProjects,
  type EffectiveWorkLane,
  type EpicWithTasks,
  type ProjectView,
  type TaskView,
} from '@pkg/composables/useProjects';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export interface ProjectTaskCardV2 {
  task:          TaskView;
  epic:          EpicWithTasks;
  subtasks:      TaskView[];
  checklistDone: number;
  commentCount:  number;
}

const HUMAN_ASSIGNEES = new Set(['human', 'owner', 'user']);
const REFRESH_MS = 15_000;

export function useProjectViewV2(projectId: () => string) {
  const {
    projects,
    lanesByProject,
    isLoading,
    error,
    load,
    select,
    loadComments,
    createTask,
    reorder,
  } = useProjects();
  const commentCounts = ref<Record<string, number>>({});
  const agentNames = ref<Record<string, string>>({
    heartbeat: 'Heartbeat',
    sulla:     'Sulla',
  });
  const mutationError = ref('');
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const project = computed<ProjectView | null>(() =>
    projects.value.find(item => item.id === projectId()) ?? null);
  const lanes = computed<EffectiveWorkLane[]>(() => lanesByProject.value[projectId()] ?? []);
  const allTasks = computed(() => (project.value?.epics ?? []).flatMap(epic =>
    epic.tasks.map(task => ({ task, epic }))));
  const taskIds = computed(() => new Set(allTasks.value.map(({ task }) => task.id)));
  const cards = computed<ProjectTaskCardV2[]>(() => allTasks.value
    .filter(({ task }) => !task.parent_id || !taskIds.value.has(task.parent_id))
    .map(({ task, epic }) => {
      const subtasks = allTasks.value
        .filter(row => row.task.parent_id === task.id)
        .map(row => row.task);

      return {
        task,
        epic,
        subtasks,
        checklistDone: subtasks.filter(isTerminalTask).length,
        commentCount:  commentCounts.value[task.id] ?? 0,
      };
    }));

  async function loadAgentNames(): Promise<void> {
    const definitions = await ipcRenderer.invoke('agent-definitions:list').catch(() => []);
    const next = { ...agentNames.value };
    for (const agent of definitions) {
      if (agent.enabled) next[agent.slug] = agent.name || agent.slug;
    }
    agentNames.value = next;
  }

  async function loadCommentCounts(): Promise<void> {
    const entries = await Promise.all(cards.value.map(async({ task }) => {
      const comments = await loadComments(task.id);

      return [task.id, comments.length] as const;
    }));
    commentCounts.value = Object.fromEntries(entries);
  }

  async function refresh(): Promise<void> {
    mutationError.value = '';
    await load();
    select(projectId());
    await loadCommentCounts();
  }

  async function addCard(title: string, laneKey: string): Promise<boolean> {
    const current = project.value;
    const epic = current?.epics[0];
    if (!current || !epic) {
      mutationError.value = 'Add an epic before adding cards.';

      return false;
    }
    mutationError.value = '';
    await createTask({
      project_id: current.id,
      epic_id:    epic.id,
      title,
      status:     laneKey,
      actor:      'human',
    });
    await loadCommentCounts();

    return true;
  }

  async function moveCard(taskId: string, laneKey: string): Promise<void> {
    mutationError.value = '';
    await reorder([{ kind: 'task', id: taskId, status: laneKey, actor: 'human' }]);
    await loadCommentCounts();
  }

  function assigneeName(assignee: string): string {
    return agentNames.value[assignee] ?? titleCase(assignee);
  }

  function isAgentAssignee(assignee: string): boolean {
    return Object.hasOwn(agentNames.value, assignee);
  }

  function waitingOnHuman(card: ProjectTaskCardV2): string | null {
    const assignee = card.task.assignee?.trim().toLowerCase();
    if (!assignee) return null;
    const human = HUMAN_ASSIGNEES.has(assignee) || assignee === 'jonathon';
    const waitingLane = card.task.lane?.semantic_role === 'blocked' || card.task.lane?.requires_human_approval;

    return human && waitingLane ? assigneeName(card.task.assignee!) : null;
  }

  onMounted(async() => {
    await Promise.all([refresh(), loadAgentNames()]);
    refreshTimer = setInterval(() => {
      if (!document.hidden && !isLoading.value) refresh().catch(() => undefined);
    }, REFRESH_MS);
  });

  onBeforeUnmount(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  watch(projectId, () => {
    refresh().catch(() => undefined);
  });

  return {
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
  };
}

export function isTerminalTask(task: TaskView): boolean {
  return task.lane?.semantic_role === 'terminal' ||
    ['done', 'cancelled'].includes(task.status);
}

export function dueState(value: string | null): 'overdue' | 'soon' | '' {
  if (!value) return '';
  const due = new Date(`${ value.slice(0, 10) }T23:59:59`).getTime();
  const now = Date.now();
  if (due < now) return 'overdue';

  return due - now < 3 * 86_400_000 ? 'soon' : '';
}

export function dueLabel(value: string | null): string {
  if (!value) return '';
  const date = new Date(`${ value.slice(0, 10) }T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day:   'numeric',
  });
}

export function linkedPullRequest(task: TaskView): { href: string; label: string } | null {
  const value = task.github_issue?.trim();
  const isPullRequest = task.source === 'github-pr-mirror' || /\/pull\/\d+/i.test(value ?? '');
  if (!value || !isPullRequest) return null;
  const match = /\/pull\/(\d+)/i.exec(value);

  return {
    href:  value.startsWith('https://') ? value : '',
    label: match ? `#${ match[1] }` : value,
  };
}

export function titleCase(value: string): string {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}
