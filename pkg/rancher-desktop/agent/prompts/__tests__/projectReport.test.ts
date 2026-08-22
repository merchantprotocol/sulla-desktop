import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const ensureTablesMock: any = jest.fn();
const listProjectsMock: any = jest.fn();
const listEpicsMock: any = jest.fn();
const listTasksMock: any = jest.fn();

jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: {
    ensureTables: ensureTablesMock,
    listProjects: listProjectsMock,
    listEpics: listEpicsMock,
    listTasks: listTasksMock,
  },
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
  });

  it('separates actionable, blocked recovery, and planning-in-flight work', async() => {
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport({ assignee: 'heartbeat' });

    expect(report).toContain('## ▶️ Actionable now (2 of 2)');
    expect(report).toContain('## 🧭 Blocked tasks — recovery planning (1 of 1)');
    expect(report).toContain('## 🛠 Planning in flight (1 of 1)');
    expect(report).toContain('council of independent high-reasoning planners');
    expect(report).toContain('choose the strongest reversible path');
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
});
