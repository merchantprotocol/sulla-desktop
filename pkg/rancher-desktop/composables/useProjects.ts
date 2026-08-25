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
  WorkTaskDependencyRecord,
  UpsertProjectInput,
  UpdateProjectInput,
  UpsertEpicInput,
  UpdateEpicInput,
  UpsertTaskInput,
  UpdateTaskInput,
} from '@pkg/agent/database/models/WorkItemsModel';
import type {
  CreateWorkLaneInput, EffectiveWorkLane, ListWorkLaneOpts, UpdateWorkLaneInput,
  ArchiveWorkLanePreview, WorkLaneDefinitionRecord, WorkLaneScope,
} from '@pkg/agent/database/models/WorkLaneDefinitionModel';
import type {
  CompatibleLaneWorkflow, LaneBindingResolution, LaneEntryAutomationRecord, LaneWorkflowBindingRecord,
  ListLaneBindingsInput, ResolveLaneBindingContextInput, SetLaneBindingInput,
} from '@pkg/agent/database/models/WorkLaneWorkflowBindingModel';
import type {
  CreateProjectPipelineTemplateInput, ProjectPipelineTemplate, ProjectPipelineTemplateRecord,
  UpdateProjectPipelineTemplateInput,
} from '@pkg/agent/database/models/WorkProjectPipelineTemplateModel';
import type {
  ProjectViewType, SaveProjectViewInput, WorkProjectViewRecord,
} from '@pkg/agent/database/models/WorkProjectViewModel';
import type { ReadyTasksResult } from '@pkg/agent/projects/application/ProjectsApplicationService';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export type {
  WorkProjectRecord, WorkEpicRecord, WorkTaskRecord, WorkCommentRecord,
  WorkActivityRecord,
  WorkTaskDependencyRecord,
  UpsertProjectInput, UpdateProjectInput, UpsertEpicInput, UpdateEpicInput,
  UpsertTaskInput, UpdateTaskInput,
  CreateWorkLaneInput, EffectiveWorkLane, ListWorkLaneOpts, UpdateWorkLaneInput,
  WorkLaneDefinitionRecord, WorkLaneScope,
  ProjectViewType, SaveProjectViewInput, WorkProjectViewRecord,
  CreateProjectPipelineTemplateInput, ProjectPipelineTemplate, ProjectPipelineTemplateRecord,
  UpdateProjectPipelineTemplateInput, ReadyTasksResult,
};

/** A task with its resolved lane attached, ready for every Projects projection. */
export interface TaskView extends WorkTaskRecord {
  lane?:            EffectiveWorkLane;
  knowledge_count?: number;
}

export interface WorkLaneRuntimeCapability {
  ready:          boolean;
  catalogPresent: boolean;
  missingRoles:   string[];
  degradedReason: string | null;
}

/** An epic with its tasks attached, ready to render. */
export interface EpicWithTasks extends WorkEpicRecord {
  tasks:            TaskView[];
  knowledge_count?: number;
}

/** A project with its epics (each carrying tasks) and roll-up counts. */
export interface ProjectView extends WorkProjectRecord {
  epics:            EpicWithTasks[];
  openCount:        number;
  doneCount:        number;
  knowledge_count?: number;
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
  const lanesByProject = ref<Record<string, EffectiveWorkLane[]>>({});
  const laneCapability = ref<WorkLaneRuntimeCapability | null>(null);

  /** currently selected project id (drives the one-project-at-a-time view) */
  const selectedId = ref<string | null>(null);

  const selected = computed<ProjectView | null>(() =>
    projects.value.find(p => p.id === selectedId.value) ?? projects.value[0] ?? null);

  function buildTree(
    rawProjects: WorkProjectRecord[],
    rawEpics: WorkEpicRecord[],
    rawTasks: WorkTaskRecord[],
    resolvedLanes: Record<string, EffectiveWorkLane[]> = {},
  ): ProjectView[] {
    const laneMaps = new Map(Object.entries(resolvedLanes).map(([projectId, lanes]) => [
      projectId, new Map(lanes.map(lane => [lane.lane_key, lane])),
    ]));
    const tasksByEpic = new Map<string, TaskView[]>();
    for (const t of rawTasks) {
      const key = t.epic_id ?? '__none__';
      const arr = tasksByEpic.get(key) ?? [];
      arr.push({ ...t, lane: laneMaps.get(t.project_id)?.get(t.status) });
      tasksByEpic.set(key, arr);
    }
    for (const arr of tasksByEpic.values()) {
      // Keep subtasks in the canonical shared dataset. Parent rows sort before
      // their children, while manual position and creation time remain stable
      // tie-breakers for every projection.
      const byId = new Map(arr.map(task => [task.id, task]));
      arr.sort((a, b) =>
        (a.parent_id === b.id ? 1 : b.parent_id === a.id ? -1 : 0) ||
        (a.parent_id && byId.has(a.parent_id) ? 1 : 0) - (b.parent_id && byId.has(b.parent_id) ? 1 : 0) ||
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
          if (t.lane ? t.lane.semantic_role === 'terminal' : CLOSED.has(t.status)) doneCount++;
          else openCount++;
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
      lanesByProject.value = board.lanesByProject ?? {};
      laneCapability.value = board.laneCapability ?? null;
      projects.value = buildTree(board.projects, board.epics, board.tasks, lanesByProject.value);
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

  async function listViews(projectId?: string | null): Promise<WorkProjectViewRecord[]> {
    return ipcRenderer.invoke('work-items:views-list', projectId);
  }

  async function resolveView(projectId?: string | null): Promise<WorkProjectViewRecord | null> {
    return ipcRenderer.invoke('work-items:view-resolve', projectId);
  }

  async function saveView(input: SaveProjectViewInput): Promise<WorkProjectViewRecord> {
    return ipcRenderer.invoke('work-items:view-save', input);
  }

  async function listTaskDependencies(projectId: string): Promise<WorkTaskDependencyRecord[]> {
    return ipcRenderer.invoke('work-items:dependencies-list', projectId);
  }

  async function setTaskDependency(taskId: string, dependsOnTaskId: string): Promise<WorkTaskDependencyRecord> {
    return ipcRenderer.invoke('work-items:dependency-set', taskId, dependsOnTaskId);
  }

  async function removeTaskDependency(taskId: string, dependsOnTaskId: string): Promise<boolean> {
    return ipcRenderer.invoke('work-items:dependency-remove', taskId, dependsOnTaskId);
  }

  async function listReadyTasks(projectId: string, epicId?: string): Promise<ReadyTasksResult> {
    return ipcRenderer.invoke('work-items:ready-tasks', { projectId, epicId });
  }

  async function listPipelineTemplates(includeArchived = false): Promise<ProjectPipelineTemplateRecord[]> {
    return ipcRenderer.invoke('work-items:pipeline-templates-list', includeArchived);
  }

  async function getPipelineTemplate(templateId: string): Promise<ProjectPipelineTemplate | null> {
    return ipcRenderer.invoke('work-items:pipeline-template-get', templateId);
  }

  async function createPipelineTemplate(input: CreateProjectPipelineTemplateInput): Promise<ProjectPipelineTemplate> {
    return ipcRenderer.invoke('work-items:pipeline-template-create', input);
  }

  async function updatePipelineTemplate(
    templateId: string,
    input: UpdateProjectPipelineTemplateInput,
  ): Promise<ProjectPipelineTemplate> {
    return ipcRenderer.invoke('work-items:pipeline-template-update', templateId, input);
  }

  async function archivePipelineTemplate(templateId: string): Promise<ProjectPipelineTemplateRecord | null> {
    return ipcRenderer.invoke('work-items:pipeline-template-archive', templateId);
  }

  async function applyPipelineTemplate(projectId: string, templateId: string): Promise<ProjectPipelineTemplate> {
    const template = await ipcRenderer.invoke('work-items:pipeline-template-apply', projectId, templateId);
    await load();
    return template;
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

  async function previewArchiveLane(id: string): Promise<ArchiveWorkLanePreview> {
    return ipcRenderer.invoke('work-items:lane-archive-preview', id);
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

  async function resolveLaneWorkflowContext(input: ResolveLaneBindingContextInput): Promise<LaneBindingResolution> {
    return ipcRenderer.invoke('work-items:lane-workflow-resolve-context', input);
  }

  async function listCompatibleLaneWorkflows(projectId: string, laneKey: string): Promise<CompatibleLaneWorkflow[]> {
    return ipcRenderer.invoke('work-items:lane-compatible-workflows', projectId, laneKey);
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
    lanesByProject,
    laneCapability,
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
    listViews,
    resolveView,
    saveView,
    listTaskDependencies,
    setTaskDependency,
    removeTaskDependency,
    listReadyTasks,
    listPipelineTemplates,
    getPipelineTemplate,
    createPipelineTemplate,
    updatePipelineTemplate,
    archivePipelineTemplate,
    applyPipelineTemplate,
    reorder,
    listLanes,
    resolveLanes,
    createLane,
    updateLane,
    archiveLane,
    previewArchiveLane,
    restoreLane,
    reorderLanes,
    resetLaneOverride,
    listLaneWorkflowBindings,
    setLaneWorkflowBinding,
    removeLaneWorkflowBinding,
    resolveLaneWorkflow,
    resolveLaneWorkflowContext,
    listCompatibleLaneWorkflows,
    inspectLaneEntryAutomation,
  };
}
