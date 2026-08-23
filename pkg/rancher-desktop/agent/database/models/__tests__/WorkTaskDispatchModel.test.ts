import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

describe('WorkTaskDispatchModel', () => {
  let originalTransaction: any;

  beforeAll(() => {
    originalTransaction = postgresClient.transaction;
  });

  afterEach(() => {
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('claims the next eligible task under a row lock and creates its live lease atomically', async() => {
    const task = {
      id:          'task-1',
      project_id:  'project-1',
      epic_id:     'epic-1',
      title:       'Ship it',
      description: '',
      status:      'todo',
      priority:    'high',
      labels:      [],
    } as any;
    const dispatch = {
      id:        'dispatch-1',
      task_id:   'task-1',
      agent_id:  'opus-worker',
      thread_id: 'thread-1',
      status:    'running',
    } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [dispatch] })
      .mockResolvedValueOnce({ rows: [] });

    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    const claimed = await WorkTaskDispatchModel.claimNext('opus-worker', 'core-todo');

    expect(claimed).toMatchObject({ task: { id: 'task-1' }, dispatch: { task_id: 'task-1' } });
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(query.mock.calls[0][0]).toContain("t.status = 'todo'");
    expect(query.mock.calls[0][0]).toContain('work_task_dispatches');
    expect(query.mock.calls[0][0]).toContain("FROM unnest(COALESCE(t.labels, '{}')) AS label");
    expect(query.mock.calls[0][0]).toContain('child.parent_id = t.id');
    expect(query.mock.calls[0][0]).toContain('t.due_at ASC NULLS LAST');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO work_task_dispatches');
    expect(query.mock.calls[1][0]).toContain('run_kind');
    expect(query.mock.calls[1][0]).toContain('MAX(attempt_count)');
    expect(query.mock.calls[1][1][4]).toBe('core-todo');
    expect(query.mock.calls[2][0]).toContain("status = 'in_progress'");
    expect(query.mock.calls[2][0]).toContain("assignee = 'dispatcher'");
  });

  it('returns null without mutating when no eligible task exists', async() => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('opus-worker')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('recovers stale leases without duplicating work that already has verified custody', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ id: 'dispatch-1', task_id: 'task-1' }] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.recoverStale(45)).resolves.toEqual(['task-1']);
    expect(query.mock.calls[0][0]).toContain("status = 'stale'");
    expect(query.mock.calls[0][0]).toContain("interval '1 minute'");
    expect(query.mock.calls[1][0]).toContain("THEN 'in_review' ELSE 'todo'");
    expect(query.mock.calls[1][0]).toContain("reviewer_verdict = 'pass'");
    expect(query.mock.calls[1][0]).toContain("status = 'in_progress'");
    expect(query.mock.calls[1][0]).toContain("assignee = 'dispatcher'");
  });

  it('finalizes ledger evidence, task state, and Projects comment in one transaction', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ status: 'running' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await WorkTaskDispatchModel.finalize('dispatch-1', 'task-1', {
      dispatchStatus: 'completed',
      taskStatus:     'in_review',
      taskAssignee:   'heartbeat',
      comment:        'Verified custody.',
      result:         'done',
      evidence:       { artifactUrl: 'https://github.com/o/r/pull/1', contentHash: 'abc1234' },
    });

    expect((postgresClient as any).transaction).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1][0]).toContain('UPDATE work_task_dispatches');
    expect(query.mock.calls[2][0]).toContain('INSERT INTO work_task_comments');
    expect(query.mock.calls[3][0]).toContain('UPDATE work_tasks');
    expect(query.mock.calls[3][0]).toContain("status = 'in_progress'");
  });
});
