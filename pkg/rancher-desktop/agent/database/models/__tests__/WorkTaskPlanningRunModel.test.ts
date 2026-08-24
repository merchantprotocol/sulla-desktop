import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
import { WorkTaskPlanningRunModel } from '../WorkTaskPlanningRunModel';

describe('WorkTaskPlanningRunModel', () => {
  let originalTransaction: any;

  beforeAll(() => {
    originalTransaction = postgresClient.transaction;
  });

  afterEach(() => {
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('claims and moves blocked work to planning in one locked transaction', async() => {
    jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ project_id: 'project-1' } as any);
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: false, catalogPresent: false, missingRoles: ['planning'], degradedReason: 'compatibility',
    });
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('planning');
    const blocked = { id: 'task-1', project_id: 'project-1', status: 'blocked', archived: false } as any;
    const planning = { ...blocked, status: 'planning', assignee: 'planning-council' };
    const run = { id: 'planning-1', task_id: 'task-1', status: 'active', attempt: 1 } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [blocked] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ attempt: 1 }] })
      .mockResolvedValueOnce({ rows: [run] })
      .mockResolvedValueOnce({ rows: [planning] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    const claimed = await WorkTaskPlanningRunModel.claim('task-1', 'blocked', 'heartbeat');

    expect(claimed).toMatchObject({ run: { status: 'active' }, task: { status: 'planning' } });
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1][0]).toContain("status = 'active'");
    expect(query.mock.calls[3][0]).toContain('INSERT INTO work_task_planning_runs');
    expect(query.mock.calls[4][0]).toContain('status = $2');
    expect(query.mock.calls[4][1]).toEqual(['task-1', 'planning']);
  });

  it('does not launch a duplicate when a task already has an active council', async() => {
    jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ project_id: 'project-1' } as any);
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: false, catalogPresent: false, missingRoles: ['planning'], degradedReason: 'compatibility',
    });
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('planning');
    const task = { id: 'task-1', project_id: 'project-1', status: 'planning', archived: false } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [task] })
      .mockResolvedValueOnce({ rows: [{ id: 'planning-existing' }] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskPlanningRunModel.claim('task-1', 'planning')).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('refreshes the active task-scoped lease by workflow execution id', async() => {
    const query = jest.spyOn(postgresClient, 'query').mockResolvedValue([] as any);

    await WorkTaskPlanningRunModel.touchByExecution('workflow-execution-1');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET heartbeat_at = now()'),
      ['workflow-execution-1'],
    );
    expect(query.mock.calls[0][0]).toContain("status = 'active'");
  });

  it('expires stale active claims and returns only tasks that still need planning', async() => {
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }, { task_id: 'task-done' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback({ query }));

    await expect(WorkTaskPlanningRunModel.recoverStale(45)).resolves.toEqual(['task-1']);
    expect(query.mock.calls[0][0]).toContain("status = 'stale'");
    expect(query.mock.calls[0][0]).toContain("interval '1 minute'");
    expect(query.mock.calls[1][0]).toContain("effective.semantic_role IN ('planning', 'blocked')");
  });

  it('expires one abandoned claim on the task next status event', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ id: 'planning-1' } as any);

    await expect(WorkTaskPlanningRunModel.recoverStaleForTask('task-1', 45)).resolves.toBe(true);
    expect(queryOne.mock.calls[0][0]).toContain("status = 'stale'");
    expect(queryOne.mock.calls[0][0]).toContain("interval '1 minute'");
    expect(queryOne.mock.calls[0][1]).toEqual(['task-1', 45]);
  });
});
