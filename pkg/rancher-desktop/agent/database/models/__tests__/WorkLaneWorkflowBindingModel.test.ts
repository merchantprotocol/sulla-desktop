import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { WorkTaskDependencyModel } from '../WorkTaskDependencyModel';
import { DISPATCHER_RECONCILED_LANE_MESSAGE } from '../WorkflowExecutionModel';
import {
  LANE_ENTRY_INPUT_ENVELOPE, LANE_OUTCOME_OUTPUT_ENVELOPE,
  WorkLaneWorkflowBindingModel,
} from '../WorkLaneWorkflowBindingModel';

const contract = {
  laneKeys:      ['in_review'],
  semanticRoles: ['review'],
  input:         LANE_ENTRY_INPUT_ENVELOPE,
  output:        LANE_OUTCOME_OUTPUT_ENVELOPE,
};

describe('WorkLaneWorkflowBindingModel', () => {
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;
  const originalTransaction = postgresClient.transaction;

  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('proves epic > project > global > core precedence while falling through unavailable rows', async() => {
    (postgresClient as any).queryOne = (jest.fn() as any)
      .mockResolvedValueOnce({ project_id: 'project-1', epic_id: 'epic-1', semantic_role: 'review', system_required: true })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'project-wf', definition: { laneContract: contract }, enabled: true, status: 'production', system: false });
    (postgresClient as any).query = jest.fn(() => Promise.resolve([
      { id: 'epic-binding', scope: 'epic', workflow_id: 'missing' },
      { id: 'project-binding', scope: 'project', workflow_id: 'project-wf' },
      { id: 'global-binding', scope: 'global', workflow_id: 'global-wf' },
      { id: 'core-binding', scope: 'core', workflow_id: 'core-wf' },
    ]));

    const resolved = await WorkLaneWorkflowBindingModel.resolve('task-1', 'in_review');

    expect(resolved.source).toBe('project');
    expect(resolved.workflowId).toBe('project-wf');
    expect(resolved.fallbackReason).toContain('unavailable');
    const sql = (postgresClient.query as any).mock.calls[0][0];
    expect(sql).toContain("WHEN 'epic' THEN 0 WHEN 'project' THEN 1 WHEN 'global' THEN 2 ELSE 3");
    expect(sql).toContain("scope = 'core' AND (lane_key = $4 OR (lane_key IS NULL AND semantic_role = $5))");
  });

  it('allows binding a workflow that has no lane contract at all', async() => {
    (postgresClient as any).queryOne = (jest.fn() as any)
      .mockResolvedValueOnce({ id: 'wf', definition: {}, enabled: true, status: 'production', system: false })
      .mockResolvedValueOnce({ lane_key: 'todo', semantic_role: 'execution' });
    (postgresClient as any).transaction = (jest.fn() as any).mockImplementation((cb: any) => cb({
      query: (jest.fn() as any).mockResolvedValue({ rows: [{ id: 'binding-1' }] }),
    }));
    await expect(WorkLaneWorkflowBindingModel.set({ scope: 'global', workflowId: 'wf', laneKey: 'todo' }))
      .resolves.toEqual(expect.objectContaining({ id: 'binding-1' }));
  });

  it('lists every enabled, non-archived workflow regardless of declared lane contract', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({
      lane_key: 'in_review', semantic_role: 'review', system_required: true,
    }));
    (postgresClient as any).query = jest.fn(() => Promise.resolve([
      { id: 'reviewer', name: 'Reviewer', description: null, definition: { laneContract: contract }, enabled: true, status: 'production', system: true },
      { id: 'planner', name: 'Planner', description: null, definition: { laneContract: { ...contract, semanticRoles: ['planning'] } }, enabled: true, status: 'production', system: false },
      { id: 'plain', name: 'Plain', description: null, definition: {}, enabled: true, status: 'production', system: false },
    ]));

    await expect(WorkLaneWorkflowBindingModel.listCompatibleWorkflows('project-1', 'in_review')).resolves.toEqual([
      expect.objectContaining({ id: 'reviewer', name: 'Reviewer', system: true }),
      expect.objectContaining({ id: 'planner', name: 'Planner', system: false }),
      expect.objectContaining({ id: 'plain', name: 'Plain', system: false }),
    ]);
  });

  it('previews effective provenance for an epic without duplicating resolution in the renderer', async() => {
    (postgresClient as any).queryOne = (jest.fn() as any)
      .mockResolvedValueOnce({ id: 'project-1' })
      .mockResolvedValueOnce({ id: 'epic-1' })
      .mockResolvedValueOnce({ id: 'project-1' })
      .mockResolvedValueOnce({ lane_key: 'in_review', semantic_role: 'review', system_required: true })
      .mockResolvedValueOnce({ id: 'reviewer', definition: { laneContract: contract }, enabled: true, status: 'production', system: true });
    (postgresClient as any).query = jest.fn(() => Promise.resolve([
      { id: 'epic-binding', scope: 'epic', epic_id: 'epic-1', lane_key: 'in_review', workflow_id: 'reviewer' },
    ]));

    const result = await WorkLaneWorkflowBindingModel.resolveForContext({
      projectId: 'project-1', epicId: 'epic-1', laneKey: 'in_review',
    });

    expect(result).toEqual(expect.objectContaining({ source: 'epic', workflowId: 'reviewer' }));
    expect((postgresClient.query as any).mock.calls[0][1]).toEqual(['default', 'epic-1', 'project-1', 'in_review', 'review']);
  });

  it('never removes a protected core binding', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({ id: 'core', scope: 'core' }));
    await expect(WorkLaneWorkflowBindingModel.remove('core')).rejects.toThrow('cannot be removed');
  });

  it('serializes duplicate lane claims and returns the existing same-lane generation', async() => {
    const client = {
      query: (jest.fn() as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'entry-1', task_id: 'task-1', generation: 4, lane_key: 'todo' }] }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(client));

    const result = await WorkLaneWorkflowBindingModel.claimLaneEntry('task-1', 'todo');
    expect(result).toEqual({ created: false, entry: expect.objectContaining({ generation: 4 }) });
    expect(client.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it('boot retry reclaims reconciler-killed rows only while their lane generation is current', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([]));

    await WorkLaneWorkflowBindingModel.listRecoverable();
    const listSql = (postgresClient.query as any).mock.calls[0][0];
    expect(listSql).toContain(`lane.outcome->>'message' = '${ DISPATCHER_RECONCILED_LANE_MESSAGE }'`);
    expect(listSql).toContain('task.status = lane.lane_key');
    expect(listSql).toContain('newer.generation > lane.generation');

    await WorkLaneWorkflowBindingModel.resetFailed('entry-1');
    const resetSql = (postgresClient.query as any).mock.calls[1][0];
    expect(resetSql).toContain(`outcome->>'message' = '${ DISPATCHER_RECONCILED_LANE_MESSAGE }'`);
    expect(resetSql).toContain("status = 'pending'");
    expect(resetSql).toContain('task.status = lane.lane_key');
    expect(resetSql).toContain('newer.generation > lane.generation');
  });

  it('does not let an unresolved dependency block entry into blocked', async() => {
    const assertClaimable = jest.spyOn(WorkTaskDependencyModel, 'assertClaimable')
      .mockRejectedValue(new Error('dependency hold'));
    const client = {
      query: (jest.fn() as any)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ project_id: 'project-1', epic_id: null, semantic_role: 'blocked', system_required: true }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'entry-2', task_id: 'task-1', generation: 5, lane_key: 'blocked' }] }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(client));

    await expect(WorkLaneWorkflowBindingModel.claimLaneEntry('task-1', 'blocked'))
      .resolves.toMatchObject({ created: true, entry: { lane_key: 'blocked' } });
    expect(assertClaimable).not.toHaveBeenCalled();
  });

  it('continues rearming after a full batch of tasks without a resolvable workflow', async() => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce([{ task_id: 'task-a', lane_key: 'manual' }])
      .mockResolvedValueOnce([{ task_id: 'task-b', lane_key: 'todo' }])
      .mockResolvedValueOnce([]);
    let transactionCount = 0;
    (postgresClient as any).transaction = jest.fn(async(callback: any) => {
      transactionCount++;
      const client = {
        query: transactionCount === 1
          ? (jest.fn() as any)
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
          : (jest.fn() as any)
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ id: 'entry-b', task_id: 'task-b', lane_key: 'todo' }] }),
      };
      return callback(client);
    });
    jest.spyOn(WorkLaneWorkflowBindingModel, 'resolve')
      .mockResolvedValueOnce({ workflowId: null, binding: null, source: 'none', fallbackReason: 'none', workflowSnapshot: {} } as any)
      .mockResolvedValueOnce({ workflowId: 'workflow-todo', binding: null, source: 'core', fallbackReason: null, workflowSnapshot: {} } as any);

    await expect(WorkLaneWorkflowBindingModel.rearmCurrentUnautomated(1)).resolves.toEqual([
      expect.objectContaining({ id: 'entry-b', task_id: 'task-b' }),
    ]);
    expect((postgresClient.query as any).mock.calls.map((call: any[]) => call[1])).toEqual([
      [1, null], [1, 'task-a'], [1, 'task-b'],
    ]);
  });
});
