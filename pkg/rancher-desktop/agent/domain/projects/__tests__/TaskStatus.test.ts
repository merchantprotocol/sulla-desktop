import { TaskStatus } from '../values/TaskStatus';
import { SemanticRole } from '../values/SemanticRole';
import { DomainError } from '../errors';

describe('TaskStatus', () => {
  it('exposes the nine default statuses in order', () => {
    expect(TaskStatus.ALL.map(s => s.value)).toEqual([
      'backlog', 'todo', 'planning', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled', 'parked',
    ]);
  });
  it('maps each status to the default lane semantic role', () => {
    const expected: Record<string, SemanticRole> = {
      backlog: SemanticRole.BACKLOG,
      todo: SemanticRole.EXECUTION,
      planning: SemanticRole.PLANNING,
      in_progress: SemanticRole.EXECUTION,
      in_review: SemanticRole.REVIEW,
      blocked: SemanticRole.BLOCKED,
      done: SemanticRole.TERMINAL,
      cancelled: SemanticRole.TERMINAL,
      parked: SemanticRole.MANUAL,
    };
    for (const status of TaskStatus.ALL) {
      expect(status.semanticRole()).toBe(expected[status.value]);
    }
  });
  it('identifies terminal statuses', () => {
    expect(TaskStatus.DONE.isTerminal()).toBe(true);
    expect(TaskStatus.CANCELLED.isTerminal()).toBe(true);
    expect(TaskStatus.PARKED.isTerminal()).toBe(false);
    expect(TaskStatus.PARKED.isClosed()).toBe(true);
    expect(TaskStatus.IN_PROGRESS.isTerminal()).toBe(false);
    expect(TaskStatus.BACKLOG.isTerminal()).toBe(false);
  });
  it('of() rejects unknown; tryOf returns null; equality holds', () => {
    expect(() => TaskStatus.of('shipped')).toThrow(DomainError);
    expect(TaskStatus.tryOf('shipped')).toBeNull();
    expect(TaskStatus.of('todo').equals(TaskStatus.TODO)).toBe(true);
    expect(TaskStatus.tryOf(TaskStatus.DONE)).toBe(TaskStatus.DONE);
  });
});
