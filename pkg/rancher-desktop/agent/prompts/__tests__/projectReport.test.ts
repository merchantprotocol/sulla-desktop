import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const ensureTablesMock: any = jest.fn();
const listProjectsMock: any = jest.fn();
const listEpicsMock: any = jest.fn();
const listTasksMock: any = jest.fn();
const filterHeartbeatEligibleMock: any = jest.fn((tasks: any[]) => Promise.resolve(tasks));
const activeTaskIdsMock: any = jest.fn();
const listWaitsMock: any = jest.fn();
const settingsGetMock: any = jest.fn();

jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: {
    ensureTables: ensureTablesMock,
    listProjects: listProjectsMock,
    listEpics:    listEpicsMock,
    listTasks:    listTasksMock,
  },
}));

jest.unstable_mockModule('../../database/models/LifecycleCapabilityModel', () => ({
  LifecycleCapabilityModel: { filterHeartbeatEligible: filterHeartbeatEligibleMock },
}));

jest.unstable_mockModule('../../database/models/WorkTaskWaitModel', () => ({
  WorkTaskWaitModel: {
    activeTaskIds: activeTaskIdsMock,
    list:          listWaitsMock,
  },
}));

jest.unstable_mockModule('../../database/models/SullaSettingsModel', () => ({
  SullaSettingsModel: { get: settingsGetMock },
}));

describe('buildProjectReport activity rotation queues', () => {
  beforeEach(() => {
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
    activeTaskIdsMock.mockReset().mockResolvedValue(new Set());
    listWaitsMock.mockReset().mockResolvedValue([]);
    settingsGetMock.mockReset().mockResolvedValue(false);
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
    expect(report).toContain('## ⏳ Monitor-owned external waits (0)');
    expect(report).toContain('Shadow mode');

    const actionableStart = report.indexOf('## ▶️ Actionable now');
    const blockedStart = report.indexOf('## 🧭 Blocked tasks');
    const actionableSection = report.slice(actionableStart, blockedStart);
    expect(actionableSection).toContain('Action oldest');
    expect(actionableSection).toContain('Action newer');
    expect(actionableSection).not.toContain('Blocked oldest');
    expect(actionableSection).not.toContain('Council active');
  });

  it('mechanically removes stages owned by healthy protected services from Heartbeat context', async() => {
    filterHeartbeatEligibleMock.mockImplementation((tasks: any[]) => Promise.resolve(
      tasks.filter(task => task.id === 'action-new'),
    ));
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport({ assignee: 'heartbeat', lifecycleAware: true });

    expect(report).toContain('Action newer');
    expect(report).not.toContain('Action oldest');
    expect(report).not.toContain('Blocked oldest');
    expect(filterHeartbeatEligibleMock).toHaveBeenCalled();
  });

  it('omits active monitor-owned waits from actionable work when suppression is enabled', async() => {
    listTasksMock.mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'waiting', project_id: 'project-1', epic_id: 'epic-1', title: 'CI pending', status: 'in_review', priority: 'high' },
        { id: 'ready', project_id: 'project-1', epic_id: 'epic-1', title: 'Ready work', status: 'todo', priority: 'high' },
      ]);
    activeTaskIdsMock.mockResolvedValue(new Set(['waiting']));
    listWaitsMock.mockResolvedValue([{
      id:                          'wait-1',
      task_id:                     'waiting',
      wait_kind:                   'github_checks',
      target_key:                  'org/repo#1',
      next_check_at:               new Date().toISOString(),
      consecutive_unchanged_count: 9,
    }]);
    settingsGetMock.mockResolvedValue(true);

    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport();
    const actionable = report.slice(report.indexOf('## ▶️ Actionable now'), report.indexOf('## ⏳'));
    expect(actionable).toContain('Ready work');
    expect(actionable).not.toContain('CI pending');
    expect(report).toContain('omitted from actionable work until a material delta');
  });
});
