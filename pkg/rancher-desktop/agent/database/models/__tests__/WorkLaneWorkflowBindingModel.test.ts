import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
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
  });

  it('rejects workflows without the required input/output envelopes', async() => {
    (postgresClient as any).queryOne = (jest.fn() as any)
      .mockResolvedValueOnce({ id: 'wf', definition: { laneContract: { laneKeys: ['todo'] } }, enabled: true, status: 'production', system: false })
      .mockResolvedValueOnce({ lane_key: 'todo', semantic_role: 'execution' });
    await expect(WorkLaneWorkflowBindingModel.set({ scope: 'global', workflowId: 'wf', laneKey: 'todo' }))
      .rejects.toThrow('incompatible');
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
        .mockResolvedValueOnce({ rows: [{ id: 'entry-1', task_id: 'task-1', generation: 4, lane_key: 'todo' }] }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(client));

    const result = await WorkLaneWorkflowBindingModel.claimLaneEntry('task-1', 'todo');
    expect(result).toEqual({ created: false, entry: expect.objectContaining({ generation: 4 }) });
    expect(client.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
