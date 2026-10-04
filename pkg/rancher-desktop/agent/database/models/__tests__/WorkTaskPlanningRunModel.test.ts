import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { LifecycleCapabilityModel } from '../LifecycleCapabilityModel';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
import { WorkLaneWorkflowBindingModel } from '../WorkLaneWorkflowBindingModel';
import { WorkTaskDependencyModel } from '../WorkTaskDependencyModel';
import { WorkTaskPlanningRunModel } from '../WorkTaskPlanningRunModel';

function admissionClient(query: any): any {
  return { query: (sql: string, ...args: any[]) => sql.includes('projects-agent-admission')
    ? Promise.resolve({ rows: [] }) : query(sql, ...args) };
}

describe('WorkTaskPlanningRunModel', () => {
  let originalTransaction: any;

  beforeAll(() => {
    originalTransaction = postgresClient.transaction;
  });

  afterEach(() => {
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('claims blocked work without changing its lane', async() => {
    jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ project_id: 'project-1' } as any);
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: false, catalogPresent: false, missingRoles: ['planning'], degradedReason: 'compatibility',
    });
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('planning');
    jest.spyOn(WorkTaskDependencyModel, 'listUnresolvedDependencies').mockResolvedValue([]);
    jest.spyOn(WorkLaneWorkflowBindingModel, 'claimLaneEntryInTransaction').mockResolvedValue({
      created: true,
      entry:   { id: 'lane-entry-1', generation: 1, status: 'unautomated' } as any,
    });
    const blocked = { id: 'task-1', project_id: 'project-1', status: 'blocked', archived: false } as any;
    const planning = { ...blocked, status: 'planning', assignee: 'planning-council' };
    const run = { id: 'planning-1', task_id: 'task-1', status: 'active', attempt: 1 } as any;
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [blocked] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ attempt: 1 }] })
      .mockResolvedValueOnce({ rows: [run] })
      .mockResolvedValueOnce({ rows: [planning] })
      .mockResolvedValue({ rows: [{ id: 'projects-event-1' }] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(admissionClient(query)));

    const claimed = await WorkTaskPlanningRunModel.claim('task-1', 'blocked', 'heartbeat');

    expect(claimed).toMatchObject({ run: { status: 'active' }, task: { status: 'blocked' } });
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1][0]).toContain("status = 'active'");
    expect(query.mock.calls[3][0]).toContain('INSERT INTO work_task_planning_runs');
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE work_tasks'))).toBe(false);
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
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(admissionClient(query)));

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
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: true, catalogPresent: true, missingRoles: [], degradedReason: null,
    });
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }, { task_id: 'task-done' }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'task-1', project_id: 'project-1', status: 'plan-custom' },
          { id: 'task-done', project_id: 'project-1', status: 'done-custom' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'task-1' }] });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(admissionClient(query)));

    await expect(WorkTaskPlanningRunModel.recoverStale(45)).resolves.toEqual(['task-1']);
    expect(query.mock.calls[0][0]).toContain("status = 'stale'");
    expect(query.mock.calls[0][0]).toContain("interval '1 minute'");
    expect(query.mock.calls[2][0]).toContain("effective.semantic_role IN ('planning', 'blocked')");
  });

  it('uses a visible stable-key fallback when a project lane capability is degraded', async() => {
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready:          false,
      catalogPresent: false,
      missingRoles:   ['planning'],
      degradedReason: 'catalog unavailable',
    });
    const report = jest.spyOn(LifecycleCapabilityModel, 'report').mockResolvedValue({} as any);
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-planning' }, { task_id: 'task-custom' }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'task-planning', project_id: 'project-1', status: 'planning' },
          { id: 'task-custom', project_id: 'project-1', status: 'plan-custom' },
        ],
      });
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(admissionClient(query)));

    await expect(WorkTaskPlanningRunModel.recoverStale()).resolves.toEqual(['task-planning']);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      key: 'planning-council', health: 'degraded', fallbackMode: 'keep_current',
    }));
    expect(report.mock.calls[0][0].error).toContain('catalog unavailable');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reports a semantic query failure before using the stable-key fallback', async() => {
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: true, catalogPresent: true, missingRoles: [], degradedReason: null,
    });
    const report = jest.spyOn(LifecycleCapabilityModel, 'report').mockResolvedValue({} as any);
    const query = (jest.fn() as any)
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-planning' }, { task_id: 'task-custom' }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'task-planning', project_id: 'project-1', status: 'planning' },
          { id: 'task-custom', project_id: 'project-1', status: 'plan-custom' },
        ],
      })
      .mockRejectedValueOnce(new Error('semantic query unavailable'));
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(admissionClient(query)));

    await expect(WorkTaskPlanningRunModel.recoverStale()).resolves.toEqual(['task-planning']);
    expect(report.mock.calls[0][0]).toEqual(expect.objectContaining({
      key: 'planning-council', health: 'degraded', fallbackMode: 'keep_current',
    }));
    expect(report.mock.calls[0][0].error).toContain('semantic query unavailable');
  });

  it('expires one abandoned claim on the task next status event', async() => {
    const queryOne = jest.spyOn(postgresClient, 'queryOne').mockResolvedValue({ id: 'planning-1' } as any);

    await expect(WorkTaskPlanningRunModel.recoverStaleForTask('task-1', 45)).resolves.toBe(true);
    expect(queryOne.mock.calls[0][0]).toContain("status = 'stale'");
    expect(queryOne.mock.calls[0][0]).toContain("interval '1 minute'");
    expect(queryOne.mock.calls[0][1]).toEqual(['task-1', 45]);
  });
});
