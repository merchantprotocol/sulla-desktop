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
    requires_human_approval: false,
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

  it('persists a configured human approval gate on a lane', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve(lane()));
    (postgresClient as any).query = jest.fn(() => Promise.resolve([lane({ requires_human_approval: true })]));

    await WorkLaneDefinitionModel.update('lane-1', { requires_human_approval: true });

    expect((postgresClient.query as any).mock.calls[0][0]).toContain('requires_human_approval');
    expect((postgresClient.query as any).mock.calls[0][1]).toContain(true);
  });

  it('rejects direct disabling before any lane update can hide populated tasks', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve(lane({ lane_key: 'parked' })));
    (postgresClient as any).query = jest.fn();

    await expect(WorkLaneDefinitionModel.update('lane-1', { enabled: false, actor: 'human' }))
      .rejects.toThrow('use archive_lane');
    expect(postgresClient.query).not.toHaveBeenCalled();
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

  it('previews the exact move count and safe destinations before archive', async() => {
    (postgresClient as any).queryOne = (jest.fn() as any)
      .mockResolvedValueOnce(lane({ lane_key: 'parked', scope: 'project', project_id: 'p1' }))
      .mockResolvedValueOnce({ count: '3' });
    (postgresClient as any).query = jest.fn(() => Promise.resolve([
      lane({ lane_key: 'parked', scope: 'project', project_id: 'p1' }),
      lane({ id: 'done', lane_key: 'done', display_name: 'Done', semantic_role: 'terminal' }),
    ]));

    const preview = await WorkLaneDefinitionModel.previewArchive('lane-1');

    expect(preview.taskCount).toBe(3);
    expect(preview.destinations.map(item => item.lane_key)).toEqual(['done']);
  });

  it.each([
    ' Awaiting Vendor ',
    '   ',
  ])('boot-seeds legacy status %p byte-for-byte through the insert boundary', async(status) => {
    (postgresClient as any).query = (jest.fn() as any)
      .mockResolvedValueOnce(DEFAULT_WORK_LANES.map(item => ({ lane_key: item.lane_key })))
      .mockResolvedValueOnce([{ status }])
      .mockResolvedValueOnce([lane({ lane_key: status })]);

    const result = await WorkLaneDefinitionModel.seedDefaultsAndLegacyStatuses();

    expect(result).toEqual({ defaults: 0, legacy: 1 });
    const insert = (postgresClient.query as any).mock.calls[2];
    expect(insert[0]).toContain('INSERT INTO work_lane_definitions');
    expect(insert[1][1]).toBe(status);
    expect(insert[1][2]).toBe(status.trim() ? status : 'Whitespace-only status');
    expect((postgresClient.query as any).mock.calls.some(([sql]: [string]) =>
      sql.includes('UPDATE work_tasks'))).toBe(false);
  });

  it('resets a project override as an audit tombstone', async() => {
    (postgresClient as any).queryWithResult = jest.fn(() => Promise.resolve({ rowCount: 1 }));
    await expect(WorkLaneDefinitionModel.resetProjectOverride('p1', 'todo', 'human')).resolves.toBe(true);
    expect(postgresClient.queryWithResult).toHaveBeenCalledWith(
      expect.stringContaining('reset_at = now()'), ['p1', 'todo', 'human'],
    );
  });

  it('resolves the first active execution lane, skipping disabled and archived candidates', async() => {
    const active = [
      lane({ id: 'l-backlog', lane_key: 'backlog', semantic_role: 'backlog', position: 0 }),
      lane({ id: 'l-todo', lane_key: 'todo', semantic_role: 'execution', position: 1, enabled: false }),
      lane({ id: 'l-legacy-exec', lane_key: 'legacy-exec', semantic_role: 'execution', position: 2, archived: true }),
      lane({ id: 'l-ready-custom', lane_key: 'ready-custom', semantic_role: 'execution', position: 3 }),
      lane({ id: 'l-planning', lane_key: 'planning', semantic_role: 'planning', position: 4 }),
      lane({ id: 'l-review', lane_key: 'in_review', semantic_role: 'review', position: 5 }),
      lane({ id: 'l-blocked', lane_key: 'blocked', semantic_role: 'blocked', position: 6 }),
      lane({ id: 'l-done', lane_key: 'done', semantic_role: 'terminal', position: 7 }),
    ];
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({ present: true }));
    (postgresClient as any).query = jest.fn(() => Promise.resolve(active));

    await expect(WorkLaneDefinitionModel.preferredLaneKey('p1', 'execution', 'todo', 'first'))
      .resolves.toBe('ready-custom');
  });

  it('prefers the compatibility key on a position tie between active role lanes', async() => {
    const active = [
      lane({ id: 'l-backlog', lane_key: 'backlog', semantic_role: 'backlog', position: 0 }),
      lane({ id: 'l-other-exec', lane_key: 'other-exec', semantic_role: 'execution', position: 1 }),
      lane({ id: 'l-todo', lane_key: 'todo', semantic_role: 'execution', position: 1 }),
      lane({ id: 'l-planning', lane_key: 'planning', semantic_role: 'planning', position: 2 }),
      lane({ id: 'l-review', lane_key: 'in_review', semantic_role: 'review', position: 3 }),
      lane({ id: 'l-blocked', lane_key: 'blocked', semantic_role: 'blocked', position: 4 }),
      lane({ id: 'l-done', lane_key: 'done', semantic_role: 'terminal', position: 5 }),
    ];
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({ present: true }));
    (postgresClient as any).query = jest.fn(() => Promise.resolve(active));

    await expect(WorkLaneDefinitionModel.preferredLaneKey('p1', 'execution', 'todo', 'first'))
      .resolves.toBe('todo');
  });

  it('throws when a project has no active lane for the requested role', async() => {
    const active = [
      lane({ id: 'l-backlog', lane_key: 'backlog', semantic_role: 'backlog', position: 0 }),
      lane({ id: 'l-todo', lane_key: 'todo', semantic_role: 'execution', position: 1 }),
      lane({ id: 'l-planning', lane_key: 'planning', semantic_role: 'planning', position: 2 }),
      lane({ id: 'l-review', lane_key: 'in_review', semantic_role: 'review', position: 3 }),
      lane({ id: 'l-blocked', lane_key: 'blocked', semantic_role: 'blocked', position: 4 }),
      lane({ id: 'l-done', lane_key: 'done', semantic_role: 'terminal', position: 5 }),
    ];
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({ present: true }));
    (postgresClient as any).query = jest.fn(() => Promise.resolve(active));

    await expect(WorkLaneDefinitionModel.preferredLaneKey('p1', 'manual', 'parked', 'first'))
      .rejects.toThrow('Project p1 has no active manual lane.');
  });

  it('falls back to the compatibility key when the lane runtime capability is not ready', async() => {
    (postgresClient as any).queryOne = jest.fn(() => Promise.resolve({ present: false }));
    (postgresClient as any).query = jest.fn();

    await expect(WorkLaneDefinitionModel.preferredLaneKey('p1', 'execution', 'todo', 'first'))
      .resolves.toBe('todo');
    expect(postgresClient.query).not.toHaveBeenCalled();
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
