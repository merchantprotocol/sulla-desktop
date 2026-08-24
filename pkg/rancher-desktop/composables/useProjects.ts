/**
 * useProjects — reactive access to the Postgres Projects for the Projects
 * view. The renderer never touches the DB directly; all access is through
 * the `work-items:*` ipcRenderer bridge (see main/workItemsEvents.ts).
 *
 * Shape mirrors the ledger tree: projects → epics → tasks. We fetch the whole
 * board in one round-trip and group it on the client, which is plenty for the
 * current row counts and keeps the view a single reactive source.
 */

import { computed, ref } from 'vue';

import type {
  WorkProjectRecord,
  WorkEpicRecord,
  WorkTaskRecord,
  WorkCommentRecord,
  WorkActivityRecord,
  UpsertProjectInput,
  UpdateProjectInput,
  UpsertEpicInput,
  UpdateEpicInput,
  UpsertTaskInput,
  UpdateTaskInput,
} from '@pkg/agent/database/models/WorkItemsModel';
import type {
  CreateWorkLaneInput, EffectiveWorkLane, ListWorkLaneOpts, UpdateWorkLaneInput,
  WorkLaneDefinitionRecord, WorkLaneScope,
} from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import type {
  LaneBindingResolution, LaneEntryAutomationRecord, LaneWorkflowBindingRecord,
  ListLaneBindingsInput, SetLaneBindingInput,
} from '@pkg/agent/database/models/WorkLaneWorkflowBindingModel';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type {
  WorkProjectRecord, WorkEpicRecord, WorkTaskRecord, WorkCommentRecord,
  WorkActivityRecord,
  UpsertProjectInput, UpdateProjectInput, UpsertEpicInput, UpdateEpicInput,
  UpsertTaskInput, UpdateTaskInput,
  CreateWorkLaneInput, EffectiveWorkLane, ListWorkLaneOpts, UpdateWorkLaneInput,
  WorkLaneDefinitionRecord, WorkLaneScope,
};

/** An epic with its tasks attached, ready to render. */
export interface EpicWithTasks extends WorkEpicRecord {
  tasks: WorkTaskRecord[];
}

/** A project with its epics (each carrying tasks) and roll-up counts. */
export interface ProjectView extends WorkProjectRecord {
  epics:     EpicWithTasks[];
  openCount: number;
  doneCount: number;
}

const CLOSED = new Set(['done', 'cancelled', 'parked']);

/** One entry in a drag-reorder batch (position + optional status/epic move). */
export interface ReorderUpdate {
  kind:      'epic' | 'task';
  id:        string;
  position?: number;
  status?:   string;
  epic_id?:  string;
  actor?:    string;
}

export function useProjects() {
  const projects = ref<ProjectView[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  const loaded = ref(false);

  /** currently selected project id (drives the one-project-at-a-time view) */
  const selectedId = ref<string | null>(null);

  const selected = computed<ProjectView | null>(() =>
    projects.value.find(p => p.id === selectedId.value) ?? projects.value[0] ?? null);

  function buildTree(
    rawProjects: WorkProjectRecord[],
    rawEpics: WorkEpicRecord[],
    rawTasks: WorkTaskRecord[],
  ): ProjectView[] {
    const tasksByEpic = new Map<string, WorkTaskRecord[]>();
    for (const t of rawTasks) {
      // top-level tasks only (subtasks hang off parent_id — not shown here yet)
      if (t.parent_id) continue;
      const key = t.epic_id ?? '__none__';
      const arr = tasksByEpic.get(key) ?? [];
      arr.push(t);
      tasksByEpic.set(key, arr);
    }
    for (const arr of tasksByEpic.values()) {
      // Manual order (drag-to-reorder writes `position`); created_at breaks ties.
      arr.sort((a, b) =>
        (a.position ?? 0) - (b.position ?? 0) ||
        (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    }

    const epicsByProject = new Map<string, WorkEpicRecord[]>();
    for (const e of rawEpics) {
      const arr = epicsByProject.get(e.project_id) ?? [];
      arr.push(e);
      epicsByProject.set(e.project_id, arr);
    }
    for (const arr of epicsByProject.values()) {
      arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }

    return rawProjects.map((p) => {
      const epics: EpicWithTasks[] = (epicsByProject.get(p.id) ?? []).map(e => ({
        ...e,
        tasks: tasksByEpic.get(e.id) ?? [],
      }));
      let openCount = 0;
      let doneCount = 0;
      for (const e of epics) {
        for (const t of e.tasks) {
          if (t.status === 'done') doneCount++;
          else if (!CLOSED.has(t.status) || t.status === 'blocked') openCount++;
        }
      }

      return { ...p, epics, openCount, doneCount };
    });
  }

  async function load(): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      const board = await ipcRenderer.invoke('work-items:board');
      projects.value = buildTree(board.projects, board.epics, board.tasks);
      if (!selectedId.value && projects.value.length) {
        selectedId.value = projects.value[0].id;
      }
      loaded.value = true;
    } catch (err: any) {
      error.value = err?.message ?? String(err);
      console.error('[useProjects] board load failed:', err);
    } finally {
      isLoading.value = false;
    }
  }

  function select(id: string): void {
    selectedId.value = id;
  }

  async function loadComments(taskId: string): Promise<WorkCommentRecord[]> {
    try {
      return await ipcRenderer.invoke('work-items:comments', taskId);
    } catch {
      return [];
    }
  }

  async function loadActivity(projectId?: string, limit = 80): Promise<WorkActivityRecord[]> {
    try {
      return await ipcRenderer.invoke('work-items:activity', { projectId, limit });
    } catch {
      return [];
    }
  }

  // ── mutations (each refreshes the board so the tree stays in sync) ─────

  async function createProject(input: UpsertProjectInput): Promise<string | null> {
    const row = await ipcRenderer.invoke('work-items:project-create', input);
    await load();
    if (row?.id) selectedId.value = row.id;

    return row?.id ?? null;
  }

  async function updateProject(id: string, changes: UpdateProjectInput): Promise<void> {
    await ipcRenderer.invoke('work-items:project-update', id, changes);
    await load();
  }

  async function archiveProject(id: string): Promise<void> {
    await ipcRenderer.invoke('work-items:project-archive', id);
    if (selectedId.value === id) selectedId.value = null;
    await load();
  }

  async function createEpic(input: UpsertEpicInput): Promise<void> {
    await ipcRenderer.invoke('work-items:epic-create', input);
    await load();
  }

  async function updateEpic(id: string, changes: UpdateEpicInput): Promise<void> {
    await ipcRenderer.invoke('work-items:epic-update', id, changes);
    await load();
  }

  async function archiveEpic(id: string): Promise<void> {
    await ipcRenderer.invoke('work-items:epic-archive', id);
    await load();
  }

  async function createTask(input: UpsertTaskInput): Promise<void> {
    await ipcRenderer.invoke('work-items:task-create', input);
    await load();
  }

  async function updateTask(id: string, changes: UpdateTaskInput): Promise<void> {
    await ipcRenderer.invoke('work-items:task-update', id, changes);
    await load();
  }

  async function archiveTask(id: string): Promise<void> {
    await ipcRenderer.invoke('work-items:task-archive', id);
    await load();
  }

  async function addComment(taskId: string, body: string, author?: string): Promise<WorkCommentRecord> {
    const row = await ipcRenderer.invoke('work-items:comment-add', { task_id: taskId, body, author });

    return row;
  }

  /** Apply a drag-reorder batch (positions + optional status/epic move), then refresh. */
  async function reorder(updates: ReorderUpdate[]): Promise<void> {
    if (!updates.length) return;
    await ipcRenderer.invoke('work-items:reorder', updates);
    await load();
  }

  async function listLanes(opts: ListWorkLaneOpts = {}): Promise<WorkLaneDefinitionRecord[]> {
    return ipcRenderer.invoke('work-items:lanes-list', opts);
  }

  async function resolveLanes(projectId: string, includeArchived = false): Promise<EffectiveWorkLane[]> {
    return ipcRenderer.invoke('work-items:lanes-resolve', projectId, includeArchived);
  }

  async function createLane(input: CreateWorkLaneInput): Promise<WorkLaneDefinitionRecord> {
    return ipcRenderer.invoke('work-items:lane-create', input);
  }

  async function updateLane(id: string, changes: UpdateWorkLaneInput): Promise<WorkLaneDefinitionRecord | null> {
    return ipcRenderer.invoke('work-items:lane-update', id, changes);
  }

  async function archiveLane(id: string, destinationLaneKey?: string) {
    const result = await ipcRenderer.invoke('work-items:lane-archive', id, destinationLaneKey);
    await load();
    return result;
  }

  async function restoreLane(id: string): Promise<WorkLaneDefinitionRecord | null> {
    return ipcRenderer.invoke('work-items:lane-restore', id);
  }

  async function reorderLanes(scope: WorkLaneScope, orderedKeys: string[], projectId?: string): Promise<number> {
    return ipcRenderer.invoke('work-items:lanes-reorder', scope, orderedKeys, projectId);
  }

  async function resetLaneOverride(projectId: string, laneKey: string): Promise<boolean> {
    return ipcRenderer.invoke('work-items:lane-reset-override', projectId, laneKey);
  }

  async function listLaneWorkflowBindings(input: ListLaneBindingsInput = {}): Promise<LaneWorkflowBindingRecord[]> {
    return ipcRenderer.invoke('work-items:lane-bindings-list', input);
  }

  async function setLaneWorkflowBinding(input: SetLaneBindingInput): Promise<LaneWorkflowBindingRecord> {
    return ipcRenderer.invoke('work-items:lane-binding-set', input);
  }

  async function removeLaneWorkflowBinding(id: string): Promise<LaneWorkflowBindingRecord | null> {
    return ipcRenderer.invoke('work-items:lane-binding-remove', id);
  }

  async function resolveLaneWorkflow(taskId: string, laneKey: string, profileId = 'default'): Promise<LaneBindingResolution> {
    return ipcRenderer.invoke('work-items:lane-workflow-resolve', taskId, laneKey, profileId);
  }

  async function inspectLaneEntryAutomation(taskId: string): Promise<LaneEntryAutomationRecord[]> {
    return ipcRenderer.invoke('work-items:lane-entry-automations', taskId);
  }

  return {
    projects,
    selected,
    selectedId,
    isLoading,
    error,
    loaded,
    load,
    select,
    loadComments,
    loadActivity,
    createProject,
    updateProject,
    archiveProject,
    createEpic,
    updateEpic,
    archiveEpic,
    createTask,
    updateTask,
    archiveTask,
    addComment,
    reorder,
    listLanes,
    resolveLanes,
    createLane,
    updateLane,
    archiveLane,
    restoreLane,
    reorderLanes,
    resetLaneOverride,
    listLaneWorkflowBindings,
    setLaneWorkflowBinding,
    removeLaneWorkflowBinding,
    resolveLaneWorkflow,
    inspectLaneEntryAutomation,
  };
}
