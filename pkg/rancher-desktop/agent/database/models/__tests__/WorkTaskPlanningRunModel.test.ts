import { beforeEach, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { SullaSettingsModel } from '../SullaSettingsModel';
import { postgresClient } from '../../PostgresClient';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
import { WorkLaneWorkflowBindingModel } from '../WorkLaneWorkflowBindingModel';
import { WorkTaskDependencyModel } from '../WorkTaskDependencyModel';
import { WorkTaskPlanningRunModel } from '../WorkTaskPlanningRunModel';
import { LiveWriterRegistry } from '../../../services/LiveWriterRegistry';

function admissionClient(query: any): any {
  return { query: (sql: string, ...args: any[]) => sql.includes('projects-agent-admission')
    ? Promise.resolve({ rows: [] }) : query(sql, ...args) };
}

describe('WorkTaskPlanningRunModel', () => {
  let originalTransaction: any;

  beforeAll(() => {
    originalTransaction = postgresClient.transaction;
  });

  beforeEach(() => {
    jest.spyOn(SullaSettingsModel, 'get').mockImplementation(async(_key, fallback) => fallback);
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

  it('recovers only councils with no live writer evidence', async() => {
    const query = jest.spyOn(postgresClient, 'query')
      .mockResolvedValueOnce([{ task_id: 'task-1' }, { task_id: 'task-1' }] as any)
      .mockResolvedValueOnce([] as any);
    LiveWriterRegistry.acquire('exec-live');
    try {
      await expect(WorkTaskPlanningRunModel.recoverStale(45)).resolves.toEqual(['task-1']);
      await expect(WorkTaskPlanningRunModel.recoverStaleForTask('task-2', 45)).resolves.toBe(false);
    } finally {
      LiveWriterRegistry.release('exec-live');
    }
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("run.status = 'active'");
    expect(sql).toContain('ANY($3::text[])');
    expect(sql).toContain("execution.status IN ('running', 'suspended')");
    expect(sql).toContain('execution.lease_expires_at > now()');
    expect(sql).toContain("job.status = 'running'");
    expect(query.mock.calls[0][1]).toEqual([45, null, ['exec-live']]);
    expect(query.mock.calls[1][1]).toEqual([45, 'task-2', ['exec-live']]);
  });
});
