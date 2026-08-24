import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { LifecycleCapabilityModel } from '../../../database/models/LifecycleCapabilityModel';
import { WorkItemsModel } from '../../../database/models/WorkItemsModel';
import { CreateTaskWorker } from '../create_task';
import { UpdateTaskWorker } from '../update_task';

describe('Projects task tools ownership inputs', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes direct-chat actor and requested ownership through create_task to the model boundary', async() => {
    jest.spyOn(WorkItemsModel, 'ensureTables').mockResolvedValue();
    const insert = jest.spyOn(WorkItemsModel, 'insertTask').mockResolvedValue({
      id:       'task-1',
      epic_id:  'epic-1',
      title:    'Ship it',
      status:   'todo',
      priority: 'p0',
      assignee: 'dispatcher',
    } as any);

    const result = await (new CreateTaskWorker() as any)._validatedCall({
      epic_id:  'epic-1',
      title:    'Ship it',
      status:   'todo',
      priority: 'p0',
      assignee: 'sulla',
    });

    expect(result.successBoolean).toBe(true);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ assignee: 'sulla', actor: 'sulla' }));
  });

  it('passes updated labels, ownership, and actor through update_task to the model boundary', async() => {
    jest.spyOn(WorkItemsModel, 'ensureTables').mockResolvedValue();
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue({
      id: 'task-1', project_id: 'project-1', status: 'todo',
    } as any);
    jest.spyOn(LifecycleCapabilityModel, 'assertActorCanManageTask').mockResolvedValue();
    const update = jest.spyOn(WorkItemsModel, 'updateTask').mockResolvedValue({
      id:               'task-1',
      epic_id:          'epic-1',
      title:            'Ship it',
      status:           'todo',
      priority:         'p0',
      assignee:         'dispatcher',
      position:         0,
      last_moved_at:    '',
      last_activity_at: '',
    } as any);

    const result = await (new UpdateTaskWorker() as any)._validatedCall({
      id:       'task-1',
      assignee: 'sulla',
      labels:   ['projects'],
      actor:    'dispatcher',
    });

    expect(result.successBoolean).toBe(true);
    expect(update).toHaveBeenCalledWith('task-1', expect.objectContaining({
      assignee: 'sulla',
      labels:   ['projects'],
      actor:    'dispatcher',
    }));
  });
});
