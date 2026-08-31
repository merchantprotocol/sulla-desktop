import { DomainError } from '../errors';
import { ArtifactGeneration, TaskId } from '../values';

export class DispatchLease {
  private readonly expiresAtEpochMs: number;

  constructor(
    readonly taskId: TaskId,
    readonly owner: string,
    readonly generation: ArtifactGeneration,
    expiresAt: Date,
  ) {
    if (!owner.trim()) throw new DomainError('Dispatch lease owner is required');
    if (Number.isNaN(expiresAt.getTime())) throw new DomainError('Dispatch lease expiry is invalid');
    this.expiresAtEpochMs = expiresAt.getTime();
    Object.freeze(this);
  }

  get expiresAt(): Date {
    return new Date(this.expiresAtEpochMs);
  }

  isActive(at: Date): boolean {
    return this.expiresAtEpochMs > at.getTime();
  }

  isOwnedBy(actor: string, generation: ArtifactGeneration): boolean {
    return this.owner === actor && this.generation.equals(generation);
  }

  belongsTo(taskId: TaskId): boolean {
    return this.taskId.equals(taskId);
  }
}
