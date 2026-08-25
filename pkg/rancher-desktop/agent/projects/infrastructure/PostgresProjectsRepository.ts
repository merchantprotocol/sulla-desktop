import { WorkItemsModel } from '../../database/models/WorkItemsModel';

import type {
  AddCommentInput, ListActivityOpts, ListEpicsOpts, ListOpts, SearchOpts,
  UpdateEpicInput, UpdateProjectInput, UpdateTaskInput,
  UpsertEpicInput, UpsertProjectInput, UpsertTaskInput, WorkItemKind,
} from '../../database/models/WorkItemsModel';
import type { ProjectsRepository } from '../application/ProjectsRepository';

/** Compatibility repository used while the legacy model is strangled out. */
export class PostgresProjectsRepository implements ProjectsRepository {
  verifySchema() { return WorkItemsModel.ensureTables() }
  getProject(id: string) { return WorkItemsModel.getProject(id) }
  getProjectBySlug(slug: string) { return WorkItemsModel.getProjectBySlug(slug) }
  listProjects(opts: ListOpts = {}) { return WorkItemsModel.listProjects(opts) }
  createProject(input: UpsertProjectInput) { return WorkItemsModel.upsertProject(input) }
  updateProject(id: string, changes: UpdateProjectInput) { return WorkItemsModel.updateProject(id, changes) }
  getEpic(id: string) { return WorkItemsModel.getEpic(id) }
  listEpics(opts: ListEpicsOpts = {}) { return WorkItemsModel.listEpics(opts) }
  createEpic(input: UpsertEpicInput) { return WorkItemsModel.upsertEpic(input) }
  updateEpic(id: string, changes: UpdateEpicInput) { return WorkItemsModel.updateEpic(id, changes) }
  getTask(id: string) { return WorkItemsModel.getTask(id) }
  listTasks(opts: ListOpts = {}) { return WorkItemsModel.listTasks(opts) }
  createTask(input: UpsertTaskInput) { return WorkItemsModel.insertTask(input) }
  updateTask(id: string, changes: UpdateTaskInput) { return WorkItemsModel.updateTask(id, changes) }
  archive(kind: WorkItemKind, id: string) { return WorkItemsModel.archive(kind, id) }
  addComment(input: AddCommentInput) { return WorkItemsModel.addComment(input) }
  listComments(taskId: string) { return WorkItemsModel.listComments(taskId) }
  listRecentActivity(opts: ListActivityOpts = {}) { return WorkItemsModel.listRecentActivity(opts) }
  search(opts: SearchOpts) { return WorkItemsModel.search(opts) }
  listTaskDependencies(projectId: string) { return WorkItemsModel.listTaskDependencies(projectId) }
  setTaskDependency(taskId: string, dependsOnTaskId: string, actor?: string) {
    return WorkItemsModel.setTaskDependency(taskId, dependsOnTaskId, actor);
  }

  removeTaskDependency(taskId: string, dependsOnTaskId: string) {
    return WorkItemsModel.removeTaskDependency(taskId, dependsOnTaskId);
  }
}
