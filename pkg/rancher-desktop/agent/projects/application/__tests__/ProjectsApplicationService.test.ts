import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { LifecycleCapabilityModel } from '../../../database/models/LifecycleCapabilityModel';
import { WorkLaneDefinitionModel } from '../../../database/models/WorkLaneDefinitionModel';
import { WorkLaneWorkflowBindingModel } from '../../../database/models/WorkLaneWorkflowBindingModel';
import { ArtifactCustodyPolicy } from '../../../services/ArtifactCustodyPolicy';
import { ProjectsApplicationService } from '../ProjectsApplicationService';

const current = {
  id:               'task-1',
  project_id:       'project-1',
  epic_id:          'epic-1',
  parent_id:        null,
  slug:             null,
  title:            'Protected work',
  description:      '',
  status:           'todo',
  priority:         'critical',
  due_at:           null,
  start_at:         null,
  milestone_at:     null,
  github_issue:     null,
  assignee:         'dispatcher',
  labels:           [],
  position:         0,
  source:           'agent',
  source_ref:       null,
  created_at:       '',
  updated_at:       null,
  last_moved_at:    '',
  last_activity_at: '',
  created_by:       null,
  last_moved_by:    null,
  completed_at:     null,
  archived:         false,
};

function repository() {
  return {
    getTask:    jest.fn(() => Promise.resolve(current)),
    getEpic:    jest.fn(() => Promise.resolve(null)),
    updateTask: jest.fn((_id: string, changes: any) => Promise.resolve({ ...current, ...changes })),
  } as any;
}

describe('ProjectsApplicationService lifecycle boundary', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('fails closed before persistence when the source-stage owner rejects an adapter', async() => {
    const repo = repository();
    jest.spyOn(LifecycleCapabilityModel, 'assertActorCanManageTask')
      .mockRejectedValue(new Error('source stage is protected'));
    const service = new ProjectsApplicationService(repo);

    await expect(service.updateTask('task-1', { status: 'in_review' }, {
      actor: 'heartbeat', source: 'ipc',
    })).rejects.toThrow('source stage is protected');
    expect(repo.updateTask).not.toHaveBeenCalled();
  });

  it('applies destination ownership and custody before committing review entry', async() => {
    const repo = repository();
    const guard = jest.spyOn(LifecycleCapabilityModel, 'assertActorCanManageTask').mockResolvedValue();
    jest.spyOn(WorkLaneDefinitionModel, 'semanticRoleForStatus').mockResolvedValue('execution');
    jest.spyOn(WorkLaneDefinitionModel, 'validateTaskStatus').mockResolvedValue({
      lane_key: 'in_review', semantic_role: 'review',
    } as any);
    const custody = jest.spyOn(ArtifactCustodyPolicy, 'assertForTransition').mockResolvedValue();
    const service = new ProjectsApplicationService(repo);

    const receipt = {
      workKind: 'non_code', artifactId: 'task-1', evidence: { test: true }, provenance: { actor: 'dispatcher' },
    } as const;
    await service.updateTask('task-1', { status: 'in_review', custody: receipt }, {
      actor: 'dispatcher', source: 'tool',
    });

    expect(guard.mock.calls).toEqual([
      ['todo', [], 'dispatcher'],
      ['in_review', [], 'dispatcher'],
    ]);
    expect(custody).toHaveBeenCalledWith('in_review', receipt);
    expect(repo.updateTask).toHaveBeenCalledTimes(1);
  });

  it('routes ordinary edits through the repository without lifecycle side effects', async() => {
    const repo = repository();
    const guard = jest.spyOn(LifecycleCapabilityModel, 'assertActorCanManageTask');
    const service = new ProjectsApplicationService(repo);

    await service.updateTask('task-1', { title: 'Renamed' }, { actor: 'human', source: 'ipc' });

    expect(guard).not.toHaveBeenCalled();
    expect(repo.updateTask).toHaveBeenCalledWith('task-1', { title: 'Renamed', actor: 'human' });
  });

  it('derives the next stage only from the project pipeline order', async() => {
    const repo = repository();
    repo.getTask.mockResolvedValue({ ...current, status: 'research' });
    jest.spyOn(WorkLaneDefinitionModel, 'resolveEffective').mockResolvedValue([
      { lane_key: 'intake', position: 10, enabled: true, archived: false },
      { lane_key: 'research', position: 20, enabled: true, archived: false },
      { lane_key: 'publish', position: 30, enabled: true, archived: false },
    ] as any);
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listLaneEntries').mockResolvedValue([
      { generation: 7, lane_key: 'research' },
    ] as any);
    jest.spyOn(LifecycleCapabilityModel, 'assertActorCanManageTask').mockResolvedValue();
    jest.spyOn(WorkLaneDefinitionModel, 'validateTaskStatus').mockResolvedValue({
      lane_key: 'publish', semantic_role: 'manual',
    } as any);
    const service = new ProjectsApplicationService(repo);

    await expect(service.transitionTaskRelative({
      taskId: 'task-1', direction: 'next', expectedGeneration: 7,
    }, { actor: 'publishing-routine', source: 'routine' })).resolves.toMatchObject({
      fromStage: 'research', toStage: 'publish', stagePosition: 2, previousGeneration: 7,
    });
    expect(repo.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({
      status: 'publish', actor: 'publishing-routine',
    }));
  });

  it('rejects a stale workflow generation before changing the task', async() => {
    const repo = repository();
    repo.getTask.mockResolvedValue({ ...current, status: 'research' });
    jest.spyOn(WorkLaneWorkflowBindingModel, 'listLaneEntries').mockResolvedValue([
      { generation: 8, lane_key: 'research' },
    ] as any);
    const service = new ProjectsApplicationService(repo);

    await expect(service.transitionTaskStage({
      taskId: 'task-1', stageKey: 'publish', expectedGeneration: 7,
    }, { actor: 'stale-routine', source: 'routine' })).rejects.toThrow('Stale stage generation');
    expect(repo.updateTask).not.toHaveBeenCalled();
  });
});
