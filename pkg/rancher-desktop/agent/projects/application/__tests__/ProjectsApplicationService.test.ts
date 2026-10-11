import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { WorkLaneDefinitionModel } from '../../../database/models/WorkLaneDefinitionModel';
import { ArtifactCustodyPolicy } from '../../../services/ArtifactCustodyPolicy';
import { ProjectsApplicationService } from '../ProjectsApplicationService';

const current = {
  id:               'task-1',
  project_id:       'project-1',
  epic_id:          'epic-1',
  parent_id:        null,
  slug:             null,
  title:            'Board work',
  description:      '',
  status:           'todo',
  priority:         'critical',
  due_at:           null,
  start_at:         null,
  milestone_at:     null,
  github_issue:     null,
  assignee:         'coder',
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

describe('ProjectsApplicationService plain-board boundary', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it.each(['tool', 'routine', 'heartbeat'] as const)('rejects forged human authority from %s', async(source) => {
    const repo = repository();
    const service = new ProjectsApplicationService(repo);
    await expect(service.updateTask('task-1', { status: 'in_progress', actor: 'human' }, {
      actor: 'human', source,
    })).rejects.toThrow('cannot act as the human');
    expect(repo.updateTask).not.toHaveBeenCalled();
  });

  it('lets any agent move a task between lanes with no ownership gate', async() => {
    const repo = repository();
    jest.spyOn(WorkLaneDefinitionModel, 'validateTaskStatus').mockResolvedValue({
      lane_key: 'in_review', semantic_role: 'review',
    } as any);
    const custody = jest.spyOn(ArtifactCustodyPolicy, 'assertForTransition').mockResolvedValue();
    const service = new ProjectsApplicationService(repo);

    const receipt = {
      workKind: 'non_code', artifactId: 'task-1', evidence: { test: true }, provenance: { actor: 'director' },
    } as const;
    await service.updateTask('task-1', { status: 'in_review', custody: receipt }, {
      actor: 'director', source: 'tool',
    });

    expect(custody).toHaveBeenCalledWith('in_review', receipt);
    expect(repo.updateTask).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'in_review', actor: 'director' }));
  });

  it('lets a task reach a terminal lane whatever its assignee', async() => {
    const repo = repository();
    jest.spyOn(WorkLaneDefinitionModel, 'validateTaskStatus').mockResolvedValue({
      lane_key: 'done', semantic_role: 'terminal',
    } as any);
    jest.spyOn(ArtifactCustodyPolicy, 'assertForTransition').mockResolvedValue();
    const service = new ProjectsApplicationService(repo);

    await service.updateTask('task-1', { status: 'done' }, { actor: 'coder', source: 'tool' });

    expect(repo.updateTask).toHaveBeenCalledTimes(1);
  });

  it('routes ordinary edits through the repository unchanged', async() => {
    const repo = repository();
    const service = new ProjectsApplicationService(repo);

    await service.updateTask('task-1', { title: 'Renamed' }, { actor: 'human', source: 'ipc' });

    expect(repo.updateTask).toHaveBeenCalledWith('task-1', { title: 'Renamed', actor: 'human' });
  });

  it('lets agents create and reorder lanes without a human gate', async() => {
    const create = jest.spyOn(WorkLaneDefinitionModel, 'create').mockResolvedValue({ id: 'lane-1' } as any);
    const reorder = jest.spyOn(WorkLaneDefinitionModel, 'reorder').mockResolvedValue([] as any);
    const service = new ProjectsApplicationService(repository());

    await service.createLane({ lane_key: 'qa', display_name: 'QA', scope: 'project', project_id: 'project-1' } as any, {
      actor: 'project-manager', source: 'tool',
    });
    await service.reorderLanes('project', ['todo', 'qa'], 'project-1', { actor: 'project-manager', source: 'tool' });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ lane_key: 'qa', actor: 'project-manager' }));
    expect(reorder).toHaveBeenCalledWith('project', ['todo', 'qa'], 'project-1', 'project-manager');
  });
});
