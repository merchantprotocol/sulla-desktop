import { describe, expect, it } from '@jest/globals';

import { up as migration } from '../../migrations/0065_create_work_task_waits';
import { WorkTaskWaitModel } from '../WorkTaskWaitModel';

describe('WorkTaskWaitModel', () => {
  it('normalizes check-run ordering into one exact head/check fingerprint', () => {
    const first = WorkTaskWaitModel.fingerprintGithubChecks({
      headSha: 'ABC123',
      prState: 'OPEN',
      runs:    [
        { id: 2, name: 'test', status: 'in_progress', conclusion: null },
        { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
      ],
    });
    const reordered = WorkTaskWaitModel.fingerprintGithubChecks({
      headSha: 'abc123',
      prState: 'open',
      runs:    [
        { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
        { id: 2, name: 'test', status: 'in_progress', conclusion: null },
      ],
    });
    const newHead = WorkTaskWaitModel.fingerprintGithubChecks({
      headSha: 'def456',
      prState: 'open',
      runs:    [
        { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
        { id: 2, name: 'test', status: 'in_progress', conclusion: null },
      ],
    });
    const newConclusion = WorkTaskWaitModel.fingerprintGithubChecks({
      headSha: 'abc123',
      prState: 'open',
      runs:    [
        { id: 1, name: 'lint', status: 'completed', conclusion: 'success' },
        { id: 2, name: 'test', status: 'completed', conclusion: 'success' },
      ],
    });

    expect(reordered).toBe(first);
    expect(newHead).not.toBe(first);
    expect(newConclusion).not.toBe(first);
  });

  it('persists active uniqueness and event-driven invalidation in the migration', () => {
    expect(migration).toContain('idx_work_task_waits_one_active_target');
    expect(migration).toContain("WHERE status = 'active'");
    expect(migration).toContain('invalidate_work_task_waits_from_human_comment');
    expect(migration).toContain("LOWER(COALESCE(NEW.author, '')) = 'human'");
    expect(migration).toContain('cancel_work_task_waits_from_terminal_task');
    expect(migration).toContain('invalidate_work_task_waits_from_human_task_mutation');
    expect(migration).toContain("NEW.status IN ('done', 'cancelled', 'parked')");
  });
});
