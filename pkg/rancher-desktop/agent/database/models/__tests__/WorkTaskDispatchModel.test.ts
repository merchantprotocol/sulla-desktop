import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkItemsModel } from '../WorkItemsModel';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

describe('WorkTaskDispatchModel', () => {
  let originalTransaction: any;
  let originalQuery: any;

  beforeAll(() => {
    originalTransaction = postgresClient.transaction;
    originalQuery = postgresClient.query;
  });

  afterEach(() => {
    (postgresClient as any).transaction = originalTransaction;
    (postgresClient as any).query = originalQuery;
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

    const claimed = await WorkTaskDispatchModel.claimNext('opus-worker');

    expect(claimed).toMatchObject({ task: { id: 'task-1' }, dispatch: { task_id: 'task-1' } });
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(query.mock.calls[0][0]).toContain("t.status = 'todo'");
    expect(query.mock.calls[0][0]).toContain('work_task_dispatches');
    expect(query.mock.calls[0][0]).toContain("FROM unnest(COALESCE(t.labels, '{}')) AS label");
    expect(query.mock.calls[0][0]).toContain('LOWER(t.assignee) = ANY($2::text[])');
    expect(query.mock.calls[0][1]).toEqual([
      ['done', 'cancelled', 'parked', 'blocked'],
      ['heartbeat', 'dispatcher'],
      ['gated', 'decision', 'human', 'manual', 'no-auto-dispatch'],
    ]);
    expect(query.mock.calls[0][0]).toContain('child.parent_id = t.id');
    expect(query.mock.calls[0][0]).toContain('t.due_at ASC NULLS LAST');
    expect(query.mock.calls[1][0]).toContain('INSERT INTO work_task_dispatches');
    expect(query.mock.calls[2][0]).toContain("status = 'planning'");
    expect(query.mock.calls[2][0]).toContain('assignee = $2');
    expect(query.mock.calls[2][1]).toEqual(['task-1', 'dispatcher']);
  });

  it('returns null without mutating when no eligible task exists', async() => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('opus-worker')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('flows a normalized create through scheduler claim into a dispatcher planning lease', async() => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{ id: 'epic-1', project_id: 'project-1' }])
      .mockImplementationOnce((_sql: string, params: any[]) => Promise.resolve([{
        id:          params[0],
        project_id:  params[1],
        epic_id:     params[2],
        title:       params[5],
        status:      params[7],
        priority:    params[8],
        assignee:    params[11],
        labels:      params[12],
        archived:    false,
      }]));

    const created = await WorkItemsModel.insertTask({
      id:       'task-new',
      epic_id:  'epic-1',
      title:    'Claim me',
      status:   'todo',
      assignee: 'sulla',
      actor:    'sulla',
      labels:   ['projects'],
    });
    expect(created.assignee).toBe('dispatcher');

    const clientQuery = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [created] })
      .mockResolvedValueOnce({ rows: [{
        id: 'dispatch-1', task_id: created.id, agent_id: 'opus-worker', status: 'running',
      }] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query: clientQuery }));

    const claim = await WorkTaskDispatchModel.claimNext('opus-worker');

    expect(claim?.task).toMatchObject({ id: 'task-new', assignee: 'dispatcher' });
    expect(clientQuery.mock.calls[2][0]).toContain("status = 'planning'");
    expect(clientQuery.mock.calls[2][1]).toEqual(['task-new', 'dispatcher']);
  });

  it('claims review work under the same cross-kind lease and excludes the execution agent', async() => {
    const task = { id: 'task-2', status: 'in_review', labels: [] } as any;
    const dispatch = {
      id: 'dispatch-review-1', task_id: 'task-2', kind: 'verification', attempt: 1,
    } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [dispatch] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNextReview('codex-test')).resolves.toMatchObject({
      task: { id: 'task-2' }, dispatch: { kind: 'verification' },
    });
    expect(query.mock.calls[0][0]).toContain("t.status = 'in_review'");
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(query.mock.calls[0][0]).toContain("d.status = 'running'");
    expect(query.mock.calls[0][0]).toContain("d.status IN ('failed', 'stale')");
    expect(query.mock.calls[0][0]).toContain("interval '5 minutes'");
    expect(query.mock.calls[0][0]).toContain("d.kind = 'execution'");
    expect(query.mock.calls[0][0]).toContain("<> $3");
    expect(query.mock.calls[1][0]).toContain("'verification'");
    expect(query.mock.calls[2][0]).toContain("assignee = 'verifier'");
  });

  it('releases stale planning leases back to todo in one transaction', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ id: 'dispatch-1', task_id: 'task-1', kind: 'execution' }] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.recoverStale(45)).resolves.toEqual(['task-1']);
    expect(query.mock.calls[0][0]).toContain("status = 'stale'");
    expect(query.mock.calls[0][0]).toContain("interval '1 minute'");
    expect(query.mock.calls[1][0]).toContain("status = 'todo'");
    expect(query.mock.calls[1][0]).toContain("status = 'planning'");
    expect(query.mock.calls[1][0]).toContain("assignee = 'dispatcher'");
  });

  it('returns stale verification leases to in_review instead of blocking them', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ id: 'dispatch-2', task_id: 'task-2', kind: 'verification' }] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.recoverStale(45)).resolves.toEqual(['task-2']);
    expect(query.mock.calls[1][0]).toContain("status = 'in_review'");
    expect(query.mock.calls[1][0]).toContain("assignee = 'verifier'");
  });

  it('settles the verifier verdict, exact head, comment, and task transition in one transaction', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.finalizeVerification(
      'dispatch-2', 'APPROVE', 'a'.repeat(40), 'All criteria verified.',
    )).resolves.toBe('APPROVE');
    expect(query.mock.calls[1][0]).toContain('artifact_sha = $3');
    expect(query.mock.calls[2][0]).toContain('INSERT INTO work_task_comments');
    expect(query.mock.calls[3][0]).toContain("completed_at = CASE WHEN $2 = 'done'");
    expect(query.mock.calls[3][1]).toEqual(['task-2', 'done', null]);
  });

  it('audits verifier crashes while leaving the task retryable in_review', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.failVerification('dispatch-2', 'boom')).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain("status = 'failed'");
    expect(query.mock.calls[1][1][2]).toContain('released for retry');
    expect(query.mock.calls[2][0]).toContain("status = 'in_review'");
  });

  it('returns concrete rework to the dispatcher', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.finalizeVerification(
      'dispatch-2', 'REWORK', 'c'.repeat(40), 'Missing regression test.',
    )).resolves.toBe('REWORK');
    expect(query.mock.calls[4][1]).toEqual(['task-2', 'todo', 'dispatcher']);
  });

  it('routes a third identical rework to Heartbeat recovery', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-2' }] })
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.finalizeVerification(
      'dispatch-2', 'REWORK', 'd'.repeat(40), 'Same defect.',
    )).resolves.toBe('BLOCKED');
    expect(query.mock.calls[4][1]).toEqual(['task-2', 'blocked', 'heartbeat']);
    expect(query.mock.calls[3][1][2]).toContain('retry ceiling');
  });
});
