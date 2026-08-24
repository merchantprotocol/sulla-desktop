import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SullaSettingsModel } from '../../database/models/SullaSettingsModel';
import { WorkItemsModel } from '../../database/models/WorkItemsModel';
import { WorkLaneDefinitionModel } from '../../database/models/WorkLaneDefinitionModel';
import { WorkTaskWaitModel } from '../../database/models/WorkTaskWaitModel';
import { buildProjectReport } from '../projectReport';

const seededLanes = [
  { lane_key: 'backlog', display_name: 'Backlog', semantic_role: 'backlog' },
  { lane_key: 'todo', display_name: 'Ready', semantic_role: 'execution' },
  { lane_key: 'planning', display_name: 'Planning', semantic_role: 'planning' },
  { lane_key: 'in_progress', display_name: 'Building', semantic_role: 'execution' },
  { lane_key: 'in_review', display_name: 'Review', semantic_role: 'review' },
  { lane_key: 'blocked', display_name: 'Blocked', semantic_role: 'blocked' },
  { lane_key: 'done', display_name: 'Done', semantic_role: 'terminal' },
] as any;

describe('buildProjectReport semantic queues', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(WorkItemsModel, 'ensureTables').mockResolvedValue(undefined);
    jest.spyOn(WorkItemsModel, 'listProjects').mockResolvedValue([
      { id: 'project-1', title: 'Operator Platform' } as any,
    ]);
    jest.spyOn(WorkItemsModel, 'listEpics').mockResolvedValue([
      { id: 'epic-1', project_id: 'project-1', title: 'Heartbeat' } as any,
    ]);
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: true, catalogPresent: true, missingRoles: [], degradedReason: null,
    });
    jest.spyOn(WorkLaneDefinitionModel, 'resolveEffective').mockResolvedValue(seededLanes);
    jest.spyOn(WorkTaskWaitModel, 'activeTaskIds').mockResolvedValue(new Set());
    jest.spyOn(WorkTaskWaitModel, 'list').mockResolvedValue([]);
    jest.spyOn(SullaSettingsModel, 'get').mockResolvedValue(false);
  });

  it('separates execution, blocked, and planning roles', async() => {
    jest.spyOn(WorkItemsModel, 'listTasks')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'blocked', project_id: 'project-1', epic_id: 'epic-1', title: 'Blocked', status: 'blocked', priority: 'critical' },
        { id: 'ready', project_id: 'project-1', epic_id: 'epic-1', title: 'Ready', status: 'todo', priority: 'critical' },
        { id: 'planning', project_id: 'project-1', epic_id: 'epic-1', title: 'Planning', status: 'planning', priority: 'critical' },
      ] as any);

    const report = await buildProjectReport();

    expect(report).toContain('## ▶️ Actionable now (1 of 1)');
    expect(report).toContain('## 🧭 Blocked tasks — recovery planning (1 of 1)');
    expect(report).toContain('## 🛠 Planning in flight (1 of 1)');
  });

  it('omits active monitor-owned waits from actionable work', async() => {
    jest.spyOn(WorkItemsModel, 'listTasks')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'waiting', project_id: 'project-1', epic_id: 'epic-1', title: 'CI pending', status: 'in_review', priority: 'high' },
        { id: 'ready', project_id: 'project-1', epic_id: 'epic-1', title: 'Ready work', status: 'todo', priority: 'high' },
      ] as any);
    jest.spyOn(WorkTaskWaitModel, 'activeTaskIds').mockResolvedValue(new Set(['waiting']));
    jest.spyOn(WorkTaskWaitModel, 'list').mockResolvedValue([{ task_id: 'waiting' } as any]);
    jest.spyOn(SullaSettingsModel, 'get').mockResolvedValue(true);

    const report = await buildProjectReport();
    const actionable = report.slice(report.indexOf('## ▶️ Actionable now'), report.indexOf('## ⏳'));

    expect(actionable).toContain('Ready work');
    expect(actionable).not.toContain('CI pending');
  });

  it('groups renamed and unknown lanes without dropping manual work', async() => {
    jest.spyOn(WorkLaneDefinitionModel, 'resolveEffective').mockResolvedValue([
      { lane_key: 'ready-custom', display_name: 'Launch Queue', semantic_role: 'execution' },
      { lane_key: 'waiting-custom', display_name: 'Needs Input', semantic_role: 'blocked' },
    ] as any);
    jest.spyOn(WorkItemsModel, 'listTasks')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 'ready', project_id: 'project-1', epic_id: 'epic-1', title: 'Ready custom', status: 'ready-custom', priority: 'high' },
        { id: 'blocked', project_id: 'project-1', epic_id: 'epic-1', title: 'Blocked custom', status: 'waiting-custom', priority: 'high' },
        { id: 'unknown', project_id: 'project-1', epic_id: 'epic-1', title: 'Legacy unknown', status: 'old-import', priority: 'low' },
      ] as any);

    const report = await buildProjectReport();

    expect(report).toContain('Launch Queue (execution)');
    expect(report).toContain('Blocked custom');
    expect(report).toContain('Legacy unknown');
    expect(report).toContain('Manual/custom lanes (1)');
  });
});
