import { DomainError } from '../errors';
import { ArtifactGeneration, TaskId } from '../values';

export type CustodyArtifactKind = 'code' | 'document' | 'external';

export class CustodyReceipt {
  constructor(
    readonly taskId: TaskId,
    readonly generation: ArtifactGeneration,
    readonly kind: CustodyArtifactKind,
    readonly locator: string,
    readonly exactIdentity: string,
  ) {
    if (!locator.trim()) throw new DomainError('Custody artifact locator is required');
    if (!exactIdentity.trim()) throw new DomainError('Custody artifact identity is required');
    Object.freeze(this);
  }

  matches(taskId: TaskId, generation: ArtifactGeneration): boolean {
    return this.taskId.equals(taskId) && this.generation.equals(generation);
  }
}
