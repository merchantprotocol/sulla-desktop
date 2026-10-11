import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const ensureTablesMock: any = jest.fn();
const listProjectsMock: any = jest.fn();
const listEpicsMock: any = jest.fn();
const listTasksMock: any = jest.fn();

jest.unstable_mockModule('../../database/models/WorkItemsModel', () => ({
  WorkItemsModel: {
    ensureTables: ensureTablesMock,
    listProjects: listProjectsMock,
    listEpics:    listEpicsMock,
    listTasks:    listTasksMock,
  },
}));

const dependencyHoldsMock: any = jest.fn();
jest.unstable_mockModule('../../database/models/WorkTaskDependencyModel', () => ({
  WorkTaskDependencyModel: { listUnresolvedForTasks: dependencyHoldsMock },
}));

const listHumanCommentTriageMock: any = jest.fn(() => Promise.resolve([]));
jest.unstable_mockModule('../../services/HumanCommentTriage', () => ({
  listHumanCommentTriage: listHumanCommentTriageMock,
}));

describe('buildProjectReport activity rotation queues', () => {
  beforeEach(() => {
    listHumanCommentTriageMock.mockReset().mockResolvedValue([]);
    dependencyHoldsMock.mockReset().mockResolvedValue([]);
    ensureTablesMock.mockReset().mockResolvedValue(undefined);
    listProjectsMock.mockReset().mockResolvedValue([{ id: 'project-1', title: 'Operator Platform' }]);
    listEpicsMock.mockReset().mockResolvedValue([{ id: 'epic-1', project_id: 'project-1', title: 'Heartbeat' }]);
    listTasksMock.mockReset()
      .mockResolvedValueOnce([]) // completed-window query
      .mockResolvedValueOnce([
        { id: 'blocked-old', project_id: 'project-1', epic_id: 'epic-1', title: 'Blocked oldest', status: 'blocked', priority: 'critical', assignee: 'heartbeat' },
        { id: 'action-old', project_id: 'project-1', epic_id: 'epic-1', title: 'Action oldest', status: 'todo', priority: 'critical', assignee: 'heartbeat' },
        { id: 'planning', project_id: 'project-1', epic_id: 'epic-1', title: 'Being planned', status: 'planning', priority: 'critical', assignee: 'heartbeat' },
        { id: 'action-new', project_id: 'project-1', epic_id: 'epic-1', title: 'Action newer', status: 'in_progress', priority: 'critical', assignee: 'heartbeat' },
      ]);
  });

  it('separates open, blocked, and planning work and describes the plain board', async() => {
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport({ assignee: 'heartbeat' });

    expect(report).toContain('## ▶️ Open now (2 of 2)');
    expect(report).toContain('## 🧭 Blocked tasks (1 of 1)');
    expect(report).toContain('## 🛠 In planning (1 of 1)');
    expect(report).toContain('Projects is a plain board');
    expect(report).toContain("assigned agent");
    expect(report).not.toMatch(/dispatcher|council|lifecycle|external waits/i);

    const openStart = report.indexOf('## ▶️ Open now');
    const blockedStart = report.indexOf('## 🧭 Blocked tasks');
    const openSection = report.slice(openStart, blockedStart);
    expect(openSection).toContain('Action oldest');
    expect(openSection).toContain('Action newer');
    expect(openSection).not.toContain('Blocked oldest');
    expect(openSection).not.toContain('Being planned');
  });

  it('lists dependency-held work separately from open work', async() => {
    dependencyHoldsMock.mockResolvedValue([{ taskId: 'action-new', dependsOnTaskId: 'upstream', dependsOnStatus: 'todo' }]);
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport();

    expect(report).toContain('## ▶️ Open now (1 of 1)');
    expect(report).toContain('## 🔗 Dependency-held work (1)');
    expect(report).toContain('blocked by upstream (todo)');
  });
});

describe('buildProjectReport human comments', () => {
  beforeEach(() => {
    dependencyHoldsMock.mockReset().mockResolvedValue([]);
    ensureTablesMock.mockReset().mockResolvedValue(undefined);
    listProjectsMock.mockReset().mockResolvedValue([{ id: 'project-1', title: 'Operator Platform' }]);
    listEpicsMock.mockReset().mockResolvedValue([]);
    listTasksMock.mockReset().mockResolvedValue([]);
    listHumanCommentTriageMock.mockReset().mockResolvedValue([{
      task:       { id: 'done-1', project_id: 'project-1', epic_id: null, title: 'Shipped too early', status: 'done' },
      comment_id: 'hc1',
      body:       'This is not actually done:\n the export still 500s.',
      created_at: '2026-09-28T20:00:00.000Z',
    }]);
  });

  it('puts unanswered human comments first in the Heartbeat report, whatever the ticket state', async() => {
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport({ assignee: 'heartbeat', includeHumanComments: true });

    const section = report.indexOf('## 💬 Human comments awaiting your reply (1)');
    expect(section).toBeGreaterThan(-1);
    expect(section).toBeLessThan(report.indexOf('## ✅ Completed'));
    expect(report).toContain('**Shipped too early**');
    expect(report).toContain('· done ·');
    expect(report).toContain('"This is not actually done: the export still 500s." (id done-1)');
    expect(report).toContain('add_task_comment author="heartbeat"');
    expect(report).not.toContain('dispatcher');
  });

  it('leaves the chat report unchanged', async() => {
    const { buildProjectReport } = await import('../projectReport');
    const report = await buildProjectReport({});

    expect(report).not.toContain('Human comments awaiting');
    expect(listHumanCommentTriageMock).not.toHaveBeenCalled();
  });
});
