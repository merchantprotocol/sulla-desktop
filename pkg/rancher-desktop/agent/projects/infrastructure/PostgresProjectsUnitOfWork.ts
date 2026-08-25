import { WorkItemsModel } from '../../database/models/WorkItemsModel';

import type { ProjectsUnitOfWork } from '../application/ProjectsUnitOfWork';
import type { UpdateTaskInput } from '../../database/models/WorkItemsModel';

/** PostgreSQL UoW adapter. WorkItemsModel owns the existing row-lock transaction during strangulation. */
export class PostgresProjectsUnitOfWork implements ProjectsUnitOfWork {
  updateTaskAtomically(id: string, changes: UpdateTaskInput) {
    return WorkItemsModel.updateTask(id, changes);
  }
}
