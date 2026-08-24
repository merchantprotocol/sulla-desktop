import { DomainError } from '../errors';
import { TaskId } from '../values';

export class Dependency {
  constructor(
    readonly taskId: TaskId,
    readonly dependsOnTaskId: TaskId,
    readonly satisfied: boolean,
  ) {
    if (taskId.equals(dependsOnTaskId)) throw new DomainError('A task cannot depend on itself');
    Object.freeze(this);
  }
}
