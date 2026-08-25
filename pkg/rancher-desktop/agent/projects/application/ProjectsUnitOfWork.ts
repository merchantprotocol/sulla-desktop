import type { UpdateTaskInput, WorkTaskRecord } from '../../database/models/WorkItemsModel';

/** Transactional port for commands spanning task state, custody and lane-entry outbox state. */
export interface ProjectsUnitOfWork {
  updateTaskAtomically(id: string, changes: UpdateTaskInput): Promise<WorkTaskRecord | null>;
}
