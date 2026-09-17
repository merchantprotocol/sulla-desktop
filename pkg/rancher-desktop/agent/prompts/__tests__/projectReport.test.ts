import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const ensureTablesMock: any = jest.fn();
const listProjectsMock: any = jest.fn();
const listEpicsMock: any = jest.fn();
const listTasksMock: any = jest.fn();
const filterHeartbeatEligibleMock: any = jest.fn((tasks: any[]) => Promise.resolve(tasks));
const heartbeatAccessByTaskMock: any = jest.fn((tasks: any[]) => Promise.resolve(
  new Map(tasks.map(task => [task.id, { capabilityKey: null, mode: 'unmanaged', owner: null, liveClaim: null }])),
));

jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: {
    ensureTables: ensureTablesMock,
    listProjects: listProjectsMock,
    listEpics:    listEpicsMock,
    listTasks:    listTasksMock,
  },
}));

jest.unstable_mockModule('../../database/models/LifecycleCapabilityModel', () => ({
  LifecycleCapabilityModel: {
    filterHeartbeatEligible: filterHeartbeatEligibleMock,
    heartbeatAccessByTask:   heartbeatAccessByTaskMock,
  },
}));

const activeWaitIdsMock: any = jest.fn();
const listWaitsMock: any = jest.fn();
const settingsGetMock: any = jest.fn();
const dependencyHoldsMock: any = jest.fn();

jest.unstable_mockModule('../../database/models/WorkTaskWaitModel', () => ({
  WorkTaskWaitModel: { activeTaskIds: activeWaitIdsMock, list: listWaitsMock },
}));
jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: settingsGetMock },
}));
jest.unstable_mockModule('../../database/models/WorkTaskDependencyModel', () => ({
  WorkTaskDependencyModel: { listUnresolvedForTasks: dependencyHoldsMock },
}));

describe('buildProjectReport activity rotation queues', () => {
  beforeEach(() => {
    activeWaitIdsMock.mockReset().mockResolvedValue(new Set());
    listWaitsMock.mockReset().mockResolvedValue([]);
    settingsGetMock.mockReset().mockImplementation((_key: string, fallback: boolean) => Promise.resolve(fallback));
    dependencyHoldsMock.mockReset().mockResolvedValue([]);
    ensureTablesMock.mockReset().mockResolvedValue(undefined);
    listProjectsMock.mockReset().mockResolvedValue([{ id: 'project-1', title: 'Operator Platform' }]);
    listEpicsMock.mockReset().mockResolvedValue([{ id: 'epic-1', project_id: 'project-1', title: 'Heartbeat' }]);
    listTasksMock.mockReset()
      .mockResolvedValueOnce([]) // completed-window query
      .mockResolvedValueOnce([
        { id: 'blocked-old', project_id: 'project-1', epic_id: 'epic-1', title: 'Blocked oldest', status: 'blocked', priority: 'critical', assignee: 'heartbeat' },
        { id: 'action-old', project_id: 'project-1', epic_id: 'epic-1', title: 'Action oldest', status: 'todo', priority: 'critical', assignee: 'heartbeat' },
        { id: 'planning', project_id: 'project-1', epic_id: 'epic-1', title: 'Council active', status: 'planning', priority: 'critical', assignee: 'heartbeat' },
        { id: 'action-new', project_id: 'project-1', epic_id: 'epic-1', title: 'Action newer', status: 'in_progress', priority: 'critical', assignee: 'heartbeat' },
      ]);
    filterHeartbeatEligibleMock.mockImplementation((tasks: any[]) => Promise.resolve(tasks));
    heartbeatAccessByTaskMock.mockImplementation((tasks: any[]) => Promise.resolve(
      new Map(tasks.map(task => [task.id, { capabilityKey: null, mode: 'unmanaged', owner: null, liveClaim: null }])),
    ));
  });

  it('separates actionable, blocked recovery, and planning-in-flight work', async() => {
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport({ assignee: 'heartbeat' });

    expect(report).toContain('## ▶️ Actionable now (2 of 2)');
    expect(report).toContain('## 🧭 Blocked tasks — recovery planning (1 of 1)');
    expect(report).toContain('## 🛠 Planning in flight (1 of 1)');
    expect(report).toContain('triggers the locked core planning routine');
    expect(report).toContain('Heartbeat must not launch a second council');
    expect(report).toContain('portfolio dispatch queue, not a one-task limit');
    expect(report).toContain('as many independent tasks as available sub-agent capacity allows');

    const actionableStart = report.indexOf('## ▶️ Actionable now');
    const blockedStart = report.indexOf('## 🧭 Blocked tasks');
    const actionableSection = report.slice(actionableStart, blockedStart);
    expect(actionableSection).toContain('Action oldest');
    expect(actionableSection).toContain('Action newer');
    expect(actionableSection).not.toContain('Blocked oldest');
    expect(actionableSection).not.toContain('Council active');
  });

  it('renders healthy protected ownership as data only and exposes only an explicit Heartbeat fallback', async() => {
    heartbeatAccessByTaskMock.mockImplementation((tasks: any[]) => Promise.resolve(new Map(tasks.map((task) => {
      if (task.id === 'action-new') {
        return [task.id, { capabilityKey: 'todo-execution', mode: 'heartbeat_fallback', owner: 'heartbeat', liveClaim: null }];
      }
      return [task.id, {
        capabilityKey: task.status === 'blocked' || task.status === 'planning' ? 'planning-council' : 'todo-execution',
        mode:          task.id === 'action-old' ? 'manual_hold' : 'protected_owner',
        owner:         task.id === 'action-old' ? null : 'protected-routine',
        liveClaim:     task.id === 'planning' ? { id: 'claim-plan', owner: 'protected-routine' } : null,
      }];
    }))));
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport({ assignee: 'heartbeat', lifecycleAware: true });

    expect(report).toContain('## ▶️ Explicit Heartbeat fallback (1 of 1)');
    expect(report).toContain('Action newer');
    expect(report).toContain('## 🔒 Protected lifecycle work — data only (3)');
    expect(report).toContain('Action oldest');
    expect(report).toContain('Blocked oldest');
    expect(report).toContain('live claim claim-plan by protected-routine');
    expect(report).toContain('Do not plan, execute, review, poll, reclaim, or mutate task status');
    expect(report).not.toContain('council of independent high-reasoning planners');
    expect(report).not.toContain('as many independent tasks as available sub-agent capacity allows');
  });
  function wait(overrides: Record<string, unknown> = {}) {
    return {
      wait_kind:                   'external_job',
      target_key:                  'job',
      task_id:                     'action-old',
      due_at:                      null,
      next_check_at:               '2027-09-17T10:45:00Z',
      consecutive_unchanged_count: 0,
      ...overrides,
    };
  }

  async function waitRows(waits: ReturnType<typeof wait>[]) {
    listWaitsMock.mockResolvedValue(waits);
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport();
    return report.split('\n').filter(line => line.startsWith('- **'));
  }

  it('distinguishes years and labels event dormancy without inferring adapters from prose', async() => {
    const rows = await waitRows([2026, 2027].map(year => wait({
      next_check_at: `${ year }-09-17T03:45:00-07:00`,
      target:        { description: 'Adapter installed; poll provider every minute' },
    })));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('awaiting external event or explicit adapter');
    expect(rows[0]).toContain('technical next_check_at 2026-09-17 10:45 UTC');
    expect(rows[1]).toContain('technical next_check_at 2027-09-17 10:45 UTC');
    expect(rows.join('\n')).not.toContain('next poll');
  });

  it('distinguishes undated human approval from a timed human gate', async() => {
    const rows = await waitRows([
      wait({ wait_kind: 'human_gate' }),
      wait({ wait_kind: 'human_gate', due_at: '2026-09-17T10:45:00Z' }),
    ]);
    expect(rows[0]).toContain('awaiting human approval (no deadline)');
    expect(rows[1]).toContain('awaiting human approval · due 2026-09-17 10:45 UTC');
    expect(rows.join('\n')).not.toContain('next poll');
  });

  it('keeps scheduled deadlines distinct from next GitHub polls', async() => {
    const rows = await waitRows([
      wait({ wait_kind: 'scheduled_time', due_at: '2026-09-17T10:45:00Z' }),
      wait({ wait_kind: 'github_checks' }),
    ]);
    expect(rows[0]).toContain('scheduled deadline 2026-09-17 10:45 UTC');
    expect(rows[0]).toContain('technical next_check_at 2027-09-17 10:45 UTC');
    expect(rows[1]).toContain('next poll 2027-09-17 10:45 UTC');
  });

  it('preserves invalid dates and handles missing scheduled deadlines without throwing', async() => {
    const rows = await waitRows([
      wait({ wait_kind: 'scheduled_time', due_at: 'invalid-due', next_check_at: 'invalid-check' }),
      wait({ wait_kind: 'scheduled_time', next_check_at: null }),
    ]);
    expect(rows[0]).toContain('scheduled deadline invalid-due');
    expect(rows[0]).toContain('technical next_check_at invalid-check');
    expect(rows[1]).toContain('scheduled deadline not set');
  });

  it.each([
    [false, true, 'Monitor disabled:', 2],
    [true, false, 'Shadow mode:', 2],
    [true, true, 'Heartbeat must not poll or comment on unchanged waits.', 1],
  ])('preserves monitor/suppression behavior enabled=%s suppression=%s', async(enabled, suppression, disclosure, count) => {
    settingsGetMock.mockImplementation((key: string) => Promise.resolve(
      key === 'externalWaitMonitorEnabled' ? enabled : suppression,
    ));
    activeWaitIdsMock.mockResolvedValue(new Set(['action-old']));
    listWaitsMock.mockResolvedValue([wait({ wait_kind: 'github_checks' })]);
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport();
    expect(report).toContain(disclosure);
    expect(report).toContain(`Actionable now (${ count } of ${ count })`);
    expect(report).toContain(enabled ? 'next poll 2027-09-17' : 'stored next poll (monitor disabled) 2027-09-17');
  });

  it('keeps protected lifecycle waits out of the monitor queue and preserves dependency holds', async() => {
    heartbeatAccessByTaskMock.mockResolvedValue(new Map([
      ['action-old', { mode: 'protected_owner', owner: 'dispatcher' }],
      ['action-new', { mode: 'heartbeat_fallback', owner: 'heartbeat' }],
    ]));
    dependencyHoldsMock.mockResolvedValue([{ taskId: 'action-new', dependsOnTaskId: 'upstream', dependsOnStatus: 'todo' }]);
    listWaitsMock.mockResolvedValue([wait()]);
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport({ lifecycleAware: true });
    expect(report).toContain('Monitor-owned external waits (0)');
    expect(report).toContain('Explicit Heartbeat fallback (0 of 0)');
    expect(report).toContain('blocked by upstream (todo)');
    expect(report).toContain('owner dispatcher');
  });
});
