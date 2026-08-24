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
    expect(query.mock.calls[0][0]).toContain('child.parent_id = t.id');
    expect(query.mock.calls[0][0]).toContain('t.due_at ASC NULLS LAST');
    expect(query.mock.calls[0][0]).toContain("c.stage = 'in_progress'");
    expect(query.mock.calls[1][0]).toContain('lifecycle_capabilities');
    expect(query.mock.calls[3][0]).toContain('INSERT INTO work_task_stage_claims');
    expect(query.mock.calls[4][0]).toContain('INSERT INTO work_task_dispatches');
    expect(query.mock.calls[5][0]).toContain("status = 'in_progress'");
    expect(query.mock.calls[5][0]).toContain("assignee = 'dispatcher'");
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

  it('releases stale dispatch and stage ownership before making the task reclaimable', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ id: 'dispatch-1', task_id: 'task-1' }] })
      .mockResolvedValueOnce({ rows: [] })
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
