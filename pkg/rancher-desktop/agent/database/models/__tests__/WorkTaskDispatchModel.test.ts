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
    const capability = {
      capability_key: 'todo-execution',
      enabled:        true,
      health:         'healthy',
      active_owner:   'dispatcher',
      fallback_mode:  'heartbeat',
    } as any;
    const stageClaim = {
      id:                  'stage-1',
      task_id:             'task-1',
      capability_key:      'todo-execution',
      stage:               'in_progress',
      owner:               'dispatcher',
      runtime_instance_id: 'runtime-1',
      status:              'active',
    } as any;
    const executingTask = { ...task, status: 'in_progress', assignee: 'dispatcher' };
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [capability] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stageClaim] })
      .mockResolvedValueOnce({ rows: [dispatch] })
      .mockResolvedValueOnce({ rows: [executingTask] });

    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    const claimed = await WorkTaskDispatchModel.claimNext('opus-worker', 'runtime-1');

    expect(claimed).toMatchObject({
      task:        { id: 'task-1', status: 'in_progress', assignee: 'dispatcher' },
      dispatch:    { task_id: 'task-1' },
      stage_claim: { id: 'stage-1', stage: 'in_progress' },
    });
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
    expect(query.mock.calls[0][0]).toContain("c.stage = 'in_progress'");
    expect(query.mock.calls[1][0]).toContain('lifecycle_capabilities');
    expect(query.mock.calls[3][0]).toContain('INSERT INTO work_task_stage_claims');
    expect(query.mock.calls[4][0]).toContain('INSERT INTO work_task_dispatches');
    expect(query.mock.calls[5][0]).toContain("status = 'in_progress'");
    expect(query.mock.calls[5][0]).toContain('assignee = $2');
    expect(query.mock.calls[5][1]).toEqual(['task-1', 'dispatcher']);
    expect(query.mock.calls[5][0]).toContain('RETURNING *');
  });

  it('returns null without mutating when no eligible task exists', async() => {
    const query = jest.fn(() => Promise.resolve({ rows: [] }));
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('opus-worker', 'runtime-1')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('leaves the real task and dispatch shapes untouched when lifecycle ownership is denied', async() => {
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
    const protectedCapability = {
      capability_key: 'todo-execution',
      enabled:        true,
      health:         'healthy',
      active_owner:   'replacement-executor',
      fallback_mode:  'heartbeat',
    } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [protectedCapability] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('opus-worker', 'runtime-1')).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO work_task_dispatches'))).toBe(false);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE work_tasks'))).toBe(false);
  });

  it('loses a racing stage claim without creating a dispatch or changing the task', async() => {
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
    const capability = {
      capability_key: 'todo-execution',
      enabled:        true,
      health:         'healthy',
      active_owner:   'dispatcher',
      fallback_mode:  'heartbeat',
    } as any;
    const racingClaim = {
      id:                  'stage-other',
      task_id:             'task-1',
      stage:               'in_progress',
      owner:               'dispatcher',
      runtime_instance_id: 'runtime-other',
      status:              'active',
    } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [capability] })
      .mockResolvedValueOnce({ rows: [racingClaim] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNext('opus-worker', 'runtime-1')).resolves.toBeNull();

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO work_task_dispatches'))).toBe(false);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE work_tasks'))).toBe(false);
  });

  it('flows a normalized create through lifecycle claim into a dispatcher execution lease', async() => {
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

    const capability = {
      capability_key: 'todo-execution',
      enabled:        true,
      health:         'healthy',
      active_owner:   'dispatcher',
      fallback_mode:  'heartbeat',
    } as any;
    const stageClaim = {
      id:                  'stage-new',
      task_id:             created.id,
      capability_key:      'todo-execution',
      stage:               'in_progress',
      owner:               'dispatcher',
      runtime_instance_id: 'runtime-1',
      status:              'active',
    } as any;
    const executingTask = { ...created, status: 'in_progress', assignee: 'dispatcher' };
    const clientQuery = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [created] })
      .mockResolvedValueOnce({ rows: [capability] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stageClaim] })
      .mockResolvedValueOnce({ rows: [{
        id: 'dispatch-1', task_id: created.id, agent_id: 'opus-worker', status: 'running',
      }] })
      .mockResolvedValueOnce({ rows: [executingTask] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query: clientQuery }));

    const claim = await WorkTaskDispatchModel.claimNext('opus-worker', 'runtime-1');

    expect(claim?.task).toMatchObject({ id: 'task-new', status: 'in_progress', assignee: 'dispatcher' });
    expect(claim?.stage_claim).toMatchObject({ id: 'stage-new', stage: 'in_progress' });
    expect(clientQuery.mock.calls[5][0]).toContain("status = 'in_progress'");
    expect(clientQuery.mock.calls[5][1]).toEqual(['task-new', 'dispatcher']);
  });

  it('claims review work under the same cross-kind lease and excludes the execution agent', async() => {
    const task = { id: 'task-2', status: 'in_review', labels: [] } as any;
    const capability = {
      capability_key: 'in-review-verification', enabled: true, health: 'healthy',
      active_owner: 'dispatcher', fallback_mode: 'heartbeat',
    } as any;
    const stageClaim = {
      id: 'stage-review-1', task_id: 'task-2', capability_key: 'in-review-verification',
      stage: 'in_review', owner: 'dispatcher', runtime_instance_id: 'runtime-1', status: 'active',
    } as any;
    const dispatch = {
      id: 'dispatch-review-1', task_id: 'task-2', kind: 'verification', attempt: 1,
    } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [capability] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [stageClaim] })
      .mockResolvedValueOnce({ rows: [dispatch] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.claimNextReview('codex-test', 'runtime-1')).resolves.toMatchObject({
      task: { id: 'task-2' }, dispatch: { kind: 'verification' }, stage_claim: { id: 'stage-review-1' },
    });
    expect(query.mock.calls[0][0]).toContain("t.status = 'in_review'");
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF t SKIP LOCKED');
    expect(query.mock.calls[0][0]).toContain("d.status = 'running'");
    expect(query.mock.calls[0][0]).toContain("d.status IN ('failed', 'stale')");
    expect(query.mock.calls[0][0]).toContain("interval '5 minutes'");
    expect(query.mock.calls[0][0]).toContain("d.kind = 'execution'");
    expect(query.mock.calls[0][0]).toContain("<> $3");
    expect(query.mock.calls[1][0]).toContain('lifecycle_capabilities');
    expect(query.mock.calls[3][0]).toContain('INSERT INTO work_task_stage_claims');
    expect(query.mock.calls[4][0]).toContain("'verification'");
    expect(query.mock.calls[5][0]).toContain("assignee = 'verifier'");
  });

  it('releases stale execution dispatch and stage ownership before making the task reclaimable', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ id: 'dispatch-1', task_id: 'task-1', kind: 'execution' }] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.recoverStale(45)).resolves.toEqual(['task-1']);
    expect(query.mock.calls[0][0]).toContain("status = 'stale'");
    expect(query.mock.calls[0][0]).toContain("interval '1 minute'");
    expect(query.mock.calls[1][0]).toContain('UPDATE work_task_stage_claims');
    expect(query.mock.calls[1][0]).toContain("status = 'recovered'");
    expect(query.mock.calls[1][0]).toContain("capability_key = 'todo-execution'");
    expect(query.mock.calls[1][0]).toContain("stage = 'in_progress'");
    expect(query.mock.calls[1][0]).toContain("status = 'active'");
    expect(query.mock.calls[1][1]).toEqual([['task-1']]);
    expect(query.mock.calls[2][0]).toContain("status = 'todo'");
    expect(query.mock.calls[2][0]).toContain("status = 'in_progress'");
    expect(query.mock.calls[2][0]).toContain("assignee = 'dispatcher'");
    expect(query.mock.calls[2][1]).toEqual([['task-1']]);

    const candidateSql = await captureCandidateSql();
    expect(candidateSql).toContain("c.stage = 'in_progress'");
    expect(candidateSql).toContain("c.status = 'active'");
  });

  it('returns stale verification leases to in_review instead of blocking them', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ id: 'dispatch-2', task_id: 'task-2', kind: 'verification' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskDispatchModel.recoverStale(45)).resolves.toEqual(['task-2']);
    expect(query.mock.calls[1][0]).toContain("capability_key = 'in-review-verification'");
    expect(query.mock.calls[2][0]).toContain("status = 'in_review'");
    expect(query.mock.calls[2][0]).toContain("assignee = 'verifier'");
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

async function captureCandidateSql(): Promise<string> {
  let candidateSql = '';
  const query = jest.fn((sql: string) => {
    candidateSql = sql;
    return Promise.resolve({ rows: [] });
  });
  (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));
  await WorkTaskDispatchModel.claimNext('opus-worker', 'runtime-1');
  return candidateSql;
}
