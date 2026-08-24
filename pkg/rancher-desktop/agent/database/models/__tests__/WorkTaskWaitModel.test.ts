import { describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { up as waitMigration } from '../../migrations/0065_create_work_task_waits';
import { up as migration } from '../../migrations/0074_semantic_lane_runtime_helpers';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
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
    expect(waitMigration).toContain('idx_work_task_waits_one_active_target');
    expect(waitMigration).toContain("WHERE status = 'active'");
    expect(migration).toContain('invalidate_work_task_waits_from_human_comment');
    expect(migration).toContain("LOWER(COALESCE(NEW.author, '')) = 'human'");
    expect(migration).toContain('cancel_work_task_waits_from_terminal_task');
    expect(migration).toContain('invalidate_work_task_waits_from_human_task_mutation');
    expect(migration).toContain("resolve_work_task_lane_role(NEW.id, NEW.status) <> 'terminal'");
    expect(migration).toContain("resolve_project_lane_key(task_project_id, 'review', 'in_review')");
    expect(migration).toContain("resolve_work_task_lane_role(NEW.task_id, task_status) = 'blocked'");
  });

  it('reactivates a blocked task in the same transaction as an event delta', async() => {
    const original = postgresClient.transaction;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({
        rows: [{
          id:                        'wait-1',
          task_id:                   'task-1',
          status:                    'active',
          last_observed_fingerprint: 'old',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'wait-1', task_id: 'task-1', status: 'changed' }] })
      .mockResolvedValueOnce({ rows: [{ project_id: 'project-1', status: 'blocked-custom' }] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));
    jest.spyOn(WorkLaneDefinitionModel, 'semanticRoleForStatus').mockResolvedValue('blocked');
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('review-custom');
    try {
      const result = await WorkTaskWaitModel.observe('wait-1', {
        fingerprint: 'new', outcome: 'pending', summary: 'event changed', nextCheckAt: new Date(),
      });
      expect(result.changed).toBe(true);
      expect(query.mock.calls[3][0]).toContain('WHERE id = $1 AND status = $4');
      expect(query.mock.calls[3][1]).toEqual(['task-1', 'review-custom', 'heartbeat', 'blocked-custom', true]);
    } finally {
      (postgresClient as any).transaction = original;
    }
  });
});
