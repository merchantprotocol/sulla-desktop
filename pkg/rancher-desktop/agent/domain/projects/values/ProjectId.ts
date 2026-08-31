import { DomainError } from '../errors';

export class ProjectId {
  private constructor(public readonly value: string) {
    Object.freeze(this);
  }

  static of(raw: unknown): ProjectId {
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > 128) {
      throw new DomainError(`Invalid ProjectId: ${ JSON.stringify(raw) }`);
    }
    return new ProjectId(raw.trim());
  }

  equals(other: ProjectId | null | undefined): boolean {
    return other instanceof ProjectId && other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}
