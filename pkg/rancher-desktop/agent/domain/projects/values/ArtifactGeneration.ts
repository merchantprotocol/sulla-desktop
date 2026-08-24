import { DomainError } from '../errors';

/**
 * A monotonic generation marker for a task's lane-entry / artifact custody. Ports the
 * numeric scope_generation used by WorkflowExecutionModel.findActiveByLaneScope and the
 * review generation hash used to suppress identical terminal generations. Pure value object.
 */
export class ArtifactGeneration {
  private constructor(
    public readonly generation: number,
    public readonly hash: string | null,
  ) {
    Object.freeze(this);
  }

  /** The initial generation (0, no artifacts bound yet). */
  static initial(): ArtifactGeneration {
    return new ArtifactGeneration(0, null);
  }

  static of(generation: unknown, hash: unknown = null): ArtifactGeneration {
    if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
      throw new DomainError(`Invalid ArtifactGeneration: ${JSON.stringify(generation)}`);
    }
    return new ArtifactGeneration(generation, ArtifactGeneration.normalizeHash(hash));
  }

  private static normalizeHash(hash: unknown): string | null {
    if (hash === null || hash === undefined) return null;
    if (typeof hash !== 'string') {
      throw new DomainError(`Invalid ArtifactGeneration hash: ${JSON.stringify(hash)}`);
    }
    const trimmed = hash.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  /** Next generation (increment), dropping any bound artifact hash. */
  next(): ArtifactGeneration {
    return new ArtifactGeneration(this.generation + 1, null);
  }

  /** Bind an artifact content hash to this generation (custody identity). */
  withHash(hash: string): ArtifactGeneration {
    const normalized = ArtifactGeneration.normalizeHash(hash);
    if (normalized === null) {
      throw new DomainError('ArtifactGeneration hash must be non-empty');
    }
    return new ArtifactGeneration(this.generation, normalized);
  }

  /** True if this generation strictly supersedes (comes after) another. */
  supersedes(other: ArtifactGeneration): boolean {
    return this.generation > other.generation;
  }

  /** True if both carry the same non-null artifact hash (identical terminal generation). */
  sameArtifacts(other: ArtifactGeneration): boolean {
    return this.generation === other.generation && this.hash !== null && this.hash === other.hash;
  }

  equals(other: ArtifactGeneration | null | undefined): boolean {
    return other instanceof ArtifactGeneration
      && other.generation === this.generation
      && other.hash === this.hash;
  }

  toString(): string {
    return this.hash === null ? `gen:${this.generation}` : `gen:${this.generation}#${this.hash}`;
  }
}
