import { DomainError } from '../errors';
import { ArtifactGeneration, TaskId } from '../values';

export type DurableWaitKind = 'external_job' | 'human_gate' | 'time';

export class DurableWait {
  constructor(
    readonly taskId: TaskId,
    readonly kind: DurableWaitKind,
    readonly targetKey: string,
    readonly generation: ArtifactGeneration,
    readonly active: boolean,
  ) {
    if (!targetKey.trim()) throw new DomainError('Durable wait target key is required');
    Object.freeze(this);
  }

  belongsTo(taskId: TaskId, generation: ArtifactGeneration): boolean {
    return this.taskId.equals(taskId) && this.generation.equals(generation);
  }
}
