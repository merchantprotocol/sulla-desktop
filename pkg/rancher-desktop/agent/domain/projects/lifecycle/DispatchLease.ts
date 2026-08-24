import { DomainError } from '../errors';
import { ArtifactGeneration, TaskId } from '../values';

export class DispatchLease {
  constructor(
    readonly taskId: TaskId,
    readonly owner: string,
    readonly generation: ArtifactGeneration,
    readonly expiresAt: Date,
  ) {
    if (!owner.trim()) throw new DomainError('Dispatch lease owner is required');
    if (Number.isNaN(expiresAt.getTime())) throw new DomainError('Dispatch lease expiry is invalid');
    Object.freeze(this);
  }

  isActive(at: Date): boolean {
    return this.expiresAt.getTime() > at.getTime();
  }

  isOwnedBy(actor: string, generation: ArtifactGeneration): boolean {
    return this.owner === actor && this.generation.equals(generation);
  }
}
