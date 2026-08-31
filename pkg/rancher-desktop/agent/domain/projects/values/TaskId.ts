import { DomainError } from '../errors';

/**
 * Identity of a Projects work item. Task/epic/project ids share the same short slug shape
 * (e.g. "YceX"). Pure value object — no persistence concerns.
 */
export class TaskId {
  private constructor(public readonly value: string) {
    Object.freeze(this);
  }

  static of(raw: unknown): TaskId {
    const id = TaskId.normalize(raw);
    if (id === null) {
      throw new DomainError(`Invalid TaskId: ${JSON.stringify(raw)}`);
    }
    return new TaskId(id);
  }

  static tryOf(raw: unknown): TaskId | null {
    const id = TaskId.normalize(raw);
    return id === null ? null : new TaskId(id);
  }

  static isValid(raw: unknown): boolean {
    return TaskId.normalize(raw) !== null;
  }

  private static normalize(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 128) return null;
    return trimmed;
  }

  equals(other: TaskId | null | undefined): boolean {
    return other instanceof TaskId && other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}
