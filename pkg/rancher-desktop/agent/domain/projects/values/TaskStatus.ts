import { DomainError } from '../errors';
import { SemanticRole } from './SemanticRole';

export type TaskStatusValue =
  | 'backlog' | 'todo' | 'planning' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled' | 'parked';

/**
 * Lifecycle status of a Projects task. The eight system statuses correspond 1:1 to the
 * system lane keys in WorkLaneDefinitionModel's default lane set and carry the same
 * semantic-role mapping.
 */
export class TaskStatus {
  static readonly BACKLOG = new TaskStatus('backlog');
  static readonly TODO = new TaskStatus('todo');
  static readonly PLANNING = new TaskStatus('planning');
  static readonly IN_PROGRESS = new TaskStatus('in_progress');
  static readonly IN_REVIEW = new TaskStatus('in_review');
  static readonly BLOCKED = new TaskStatus('blocked');
  static readonly DONE = new TaskStatus('done');
  static readonly CANCELLED = new TaskStatus('cancelled');
  static readonly PARKED = new TaskStatus('parked');

  static readonly ALL: readonly TaskStatus[] = Object.freeze([
    TaskStatus.BACKLOG, TaskStatus.TODO, TaskStatus.PLANNING, TaskStatus.IN_PROGRESS,
    TaskStatus.IN_REVIEW, TaskStatus.BLOCKED, TaskStatus.DONE, TaskStatus.CANCELLED, TaskStatus.PARKED,
  ]);

  /** Terminal (absorbing) statuses — no outbound lifecycle transitions. */
  static readonly CLOSED: readonly TaskStatusValue[] = Object.freeze(['done', 'cancelled', 'parked']);

  /** Default status to semantic role, mirroring the system lane default map. */
  private static readonly ROLE_BY_STATUS: Readonly<Record<TaskStatusValue, SemanticRole>> = Object.freeze({
    backlog: SemanticRole.BACKLOG,
    todo: SemanticRole.EXECUTION,
    planning: SemanticRole.PLANNING,
    in_progress: SemanticRole.EXECUTION,
    in_review: SemanticRole.REVIEW,
    blocked: SemanticRole.BLOCKED,
    done: SemanticRole.TERMINAL,
    cancelled: SemanticRole.TERMINAL,
    parked: SemanticRole.MANUAL,
  });

  private constructor(public readonly value: TaskStatusValue) {
    Object.freeze(this);
  }

  static of(raw: unknown): TaskStatus {
    const status = TaskStatus.tryOf(raw);
    if (status === null) {
      throw new DomainError(`Invalid TaskStatus: ${JSON.stringify(raw)}`);
    }
    return status;
  }

  static tryOf(raw: unknown): TaskStatus | null {
    if (raw instanceof TaskStatus) return raw;
    if (typeof raw !== 'string') return null;
    return TaskStatus.ALL.find(s => s.value === raw) ?? null;
  }

  /** The default semantic role for this status (system lane mapping). */
  semanticRole(): SemanticRole {
    return TaskStatus.ROLE_BY_STATUS[this.value];
  }

  isTerminal(): boolean {
    return this.semanticRole().isTerminal();
  }

  isClosed(): boolean {
    return TaskStatus.CLOSED.includes(this.value);
  }

  equals(other: TaskStatus | null | undefined): boolean {
    return other instanceof TaskStatus && other.value === this.value;
  }

  toString(): string {
    return this.value;
  }
}
