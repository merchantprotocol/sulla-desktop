import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { postgresClient } from '../../PostgresClient';
import { DEFAULT_WORK_LANES, WorkLaneDefinitionModel, WorkLaneDefinitionRecord } from '../WorkLaneDefinitionModel';

function lane(overrides: Partial<WorkLaneDefinitionRecord> = {}): WorkLaneDefinitionRecord {
  return {
    id:              'lane-1',
    lane_key:        'todo',
    scope:           'global_default',
    project_id:      null,
    base_lane_key:   null,
    display_name:    'To Do',
    description:     '',
    color:           null,
    icon:            null,
    position:        1,
    semantic_role:   'execution',
    enabled:         true,
    archived:        false,
    system_required: false,
    created_by:      'test',
    updated_by:      null,
    created_at:      '2026-08-23T00:00:00Z',
    updated_at:      null,
    archived_at:     null,
    reset_at:        null,
    ...overrides,
  };
}

describe('WorkLaneDefinitionModel', () => {
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;
  const originalQueryWithResult = postgresClient.queryWithResult;
  const originalTransaction = postgresClient.transaction;

  afterEach(() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).queryWithResult = originalQueryWithResult;
    (postgresClient as any).transaction = originalTransaction;
    jest.restoreAllMocks();
  });

  it('resolves a project override without leaking it into other keys', async() => {
    (postgresClient as any).query = jest.fn(() => Promise.resolve([
      lane(),
      lane({ id: 'global-review', lane_key: 'in_review', display_name: 'Review', position: 4, semantic_role: 'review' }),
      lane({ id: 'project-todo', scope: 'project', project_id: 'p1', base_lane_key: 'todo', display_name: 'Ready', position: 2 }),
      lane({ id: 'project-qa', lane_key: 'qa', scope: 'project', project_id: 'p1', display_name: 'QA', semantic_role: 'manual', position: 3 }),
    ]));

    const rows = await WorkLaneDefinitionModel.resolveEffective('p1');

    expect(rows.map(row => [row.lane_key, row.display_name, row.provenance])).toEqual([
      ['todo', 'Ready', 'project_override'],
      ['qa', 'QA', 'project_only'],
      ['in_review', 'Review', 'global'],
    ]);
    expect(rows[0].inherited_definition_id).toBe('lane-1');
  });

  it('renames presentation without ever updating the stable lane key', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve(lane()));
    (postgresClient as any).query = jest.fn(() => Promise.resolve([lane({ display_name: 'Ready' })]));

    await WorkLaneDefinitionModel.update('lane-1', { display_name: 'Ready' });

    const sql = (postgresClient.query as any).mock.calls[0][0] as string;
    expect(sql).toContain('display_name');
    expect(sql).not.toContain('lane_key =');
  });

  it('carries required-role locks into a project override', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve(lane({ system_required: true })));
    await expect(WorkLaneDefinitionModel.create({
      lane_key: 'todo', scope: 'project', project_id: 'p1', display_name: 'Ready', enabled: false,
    })).rejects.toThrow('cannot be disabled');
  });

  it('rejects archiving a populated lane until a destination is supplied', async() => {
    const client = {
      query: (jest.fn() as any)
        .mockResolvedValueOnce({ rows: [lane({ lane_key: 'parked' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(client));

    await expect(WorkLaneDefinitionModel.archive('lane-1')).rejects.toThrow('destination_lane_key is required');
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query.mock.calls[1][0]).toContain('LOCK TABLE work_tasks');
  });

  it('moves tasks and archives the lane inside one transaction', async() => {
    const client = {
      query: (jest.fn() as any)
        .mockResolvedValueOnce({ rows: [lane({ lane_key: 'parked' })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [lane({ lane_key: 'done', semantic_role: 'terminal' })] })
        .mockResolvedValueOnce({ rows: [], rowCount: 2 })
        .mockResolvedValueOnce({ rows: [lane({ lane_key: 'parked', archived: true, enabled: false })] }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(client));

    const result = await WorkLaneDefinitionModel.archive('lane-1', 'done', 'human');

    expect(result.movedTasks).toBe(2);
    expect(client.query.mock.calls[4][0]).toContain('UPDATE work_tasks SET status = $1');
    expect(client.query.mock.calls[5][0]).toContain('SET archived = true');
  });

  it('boot-seeds defaults and preserves an unknown status as its exact manual key', async() => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce(DEFAULT_WORK_LANES.map(item => ({ lane_key: item.lane_key })))
      .mockResolvedValueOnce([{ status: 'Awaiting Vendor' }]);
    const create = jest.spyOn(WorkLaneDefinitionModel, 'create').mockResolvedValue(lane());

    const result = await WorkLaneDefinitionModel.seedDefaultsAndLegacyStatuses();

    expect(result).toEqual({ defaults: 0, legacy: 1 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      lane_key: 'Awaiting Vendor', display_name: 'Awaiting Vendor', semantic_role: 'manual',
    }));
  });

  it('resets a project override as an audit tombstone', async() => {
    (postgresClient as any).queryWithResult = jest.fn(() => Promise.resolve({ rowCount: 1 }));
    await expect(WorkLaneDefinitionModel.resetProjectOverride('p1', 'todo', 'human')).resolves.toBe(true);
    expect(postgresClient.queryWithResult).toHaveBeenCalledWith(
      expect.stringContaining('reset_at = now()'), ['p1', 'todo', 'human'],
    );
  });

  it('materializes a project override when reordering an inherited lane', async() => {
    const client = {
      query: (jest.fn() as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ id: 'project-todo' }], rowCount: 1 }),
    };
    (postgresClient as any).transaction = jest.fn((callback: any) => callback(client));

    await expect(WorkLaneDefinitionModel.reorder('project', ['todo'], 'p1', 'human')).resolves.toBe(1);
    expect(client.query.mock.calls[1][0]).toContain("SELECT $1, lane_key, 'project'");
  });
});
