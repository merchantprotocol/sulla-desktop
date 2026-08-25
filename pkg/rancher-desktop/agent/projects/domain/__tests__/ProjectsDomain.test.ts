import { describe, expect, it } from '@jest/globals';

import {
  Dependency, Epic, KnowledgeAssociation, Lane, LaneKey, Project, ProjectItemId,
  ProjectView, Task, TaskLifecyclePolicy, WaitTarget,
} from '../ProjectsDomain';

describe('Projects domain value objects', () => {
  it('rejects empty identifiers and lane keys at the boundary', () => {
    expect(() => ProjectItemId.from('  ')).toThrow('id is required');
    expect(() => LaneKey.from('')).toThrow('lane key is required');
  });

  it('constructs every Projects aggregate without persistence concerns', () => {
    expect(Project.create({ id: 'p1', title: 'Project' }).title).toBe('Project');
    expect(Epic.create({ id: 'e1', projectId: 'p1', title: 'Epic' }).projectId.value).toBe('p1');
    expect(Task.create({ id: 't1', epicId: 'e1', projectId: 'p1', title: 'Task', lane: 'ready' }).lane.value).toBe('ready');
    expect(Lane.create({ key: 'ready', displayName: 'Ready', semanticRole: 'execution' }).semanticRole).toBe('execution');
    expect(WaitTarget.create('github_checks', 'repo#1').key).toBe('repo#1');
    expect(ProjectView.create({ id: 'v1', name: 'Shipping', projectId: 'p1' }).projectId?.value).toBe('p1');
    expect(KnowledgeAssociation.create({ itemKind: 'task', itemId: 't1', nodeId: 'n1' }).nodeId.value).toBe('n1');
  });

  it('rejects self-dependencies', () => {
    expect(() => Dependency.create('t1', 't1')).toThrow('cannot depend on itself');
  });

  it('rejects a task transition that silently changes projects', () => {
    expect(() => TaskLifecyclePolicy.assertTransition({
      actor:                 'human',
      destinationEpicProven: false,
      from:                  {
        taskId:       ProjectItemId.from('task-1'),
        projectId:    ProjectItemId.from('project-a'),
        lane:         LaneKey.from('todo'),
        semanticRole: 'execution',
        assignee:     'sulla',
        labels:       [],
      },
      to: {
        taskId:       ProjectItemId.from('task-1'),
        projectId:    ProjectItemId.from('project-b'),
        lane:         LaneKey.from('review'),
        semanticRole: 'review',
        assignee:     'sulla',
        labels:       [],
      },
    })).toThrow('cannot change projects');
  });

  it('allows an explicit move through an epic proven to belong to the destination project', () => {
    expect(() => TaskLifecyclePolicy.assertTransition({
      actor:                 'human',
      destinationEpicProven: true,
      from:                  {
        taskId:       ProjectItemId.from('task-1'),
        projectId:    ProjectItemId.from('project-a'),
        lane:         LaneKey.from('todo'),
        semanticRole: 'execution',
        assignee:     'sulla',
        labels:       [],
      },
      to: {
        taskId:       ProjectItemId.from('task-1'),
        projectId:    ProjectItemId.from('project-b'),
        lane:         LaneKey.from('review'),
        semanticRole: 'review',
        assignee:     'sulla',
        labels:       [],
      },
    })).not.toThrow();
  });
});
