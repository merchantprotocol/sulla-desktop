import type {
  AddCommentInput,
  ListActivityOpts,
  ListEpicsOpts,
  ListOpts,
  ListTasksOpts,
  SearchOpts,
  UpdateEpicInput,
  UpdateProjectInput,
  UpdateTaskInput,
  UpsertEpicInput,
  UpsertProjectInput,
  UpsertTaskInput,
  WorkActivityRecord,
  WorkCommentRecord,
  WorkEpicRecord,
  WorkItemKind,
  WorkProjectRecord,
  WorkTaskDependencyRecord,
  WorkTaskRecord,
  SearchHit,
} from '../../database/models/WorkItemsModel';

/** Persistence port. Application/domain code depends on this, never SQL. */
export interface ProjectsRepository {
  verifySchema(): Promise<void>;
  getProject(id: string): Promise<WorkProjectRecord | null>;
  getProjectBySlug(slug: string): Promise<WorkProjectRecord | null>;
  listProjects(opts?: ListOpts): Promise<WorkProjectRecord[]>;
  createProject(input: UpsertProjectInput): Promise<WorkProjectRecord>;
  updateProject(id: string, changes: UpdateProjectInput): Promise<WorkProjectRecord | null>;
  getEpic(id: string): Promise<WorkEpicRecord | null>;
  listEpics(opts?: ListEpicsOpts): Promise<WorkEpicRecord[]>;
  createEpic(input: UpsertEpicInput): Promise<WorkEpicRecord>;
  updateEpic(id: string, changes: UpdateEpicInput): Promise<WorkEpicRecord | null>;
  getTask(id: string): Promise<WorkTaskRecord | null>;
  listTasks(opts?: ListTasksOpts): Promise<WorkTaskRecord[]>;
  createTask(input: UpsertTaskInput): Promise<WorkTaskRecord>;
  updateTask(id: string, changes: UpdateTaskInput): Promise<WorkTaskRecord | null>;
  archive(kind: WorkItemKind, id: string): Promise<boolean>;
  addComment(input: AddCommentInput): Promise<WorkCommentRecord>;
  listComments(taskId: string): Promise<WorkCommentRecord[]>;
  listRecentActivity(opts?: ListActivityOpts): Promise<WorkActivityRecord[]>;
  search(opts: SearchOpts): Promise<SearchHit[]>;
  listTaskDependencies(projectId: string): Promise<WorkTaskDependencyRecord[]>;
  setTaskDependency(taskId: string, dependsOnTaskId: string, actor?: string): Promise<WorkTaskDependencyRecord>;
  removeTaskDependency(taskId: string, dependsOnTaskId: string): Promise<boolean>;
}
