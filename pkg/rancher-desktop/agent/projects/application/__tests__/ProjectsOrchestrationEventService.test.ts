import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ProjectsDomainEventOutbox } from '../../infrastructure/ProjectsDomainEventOutbox';
import { ProjectsOrchestrationEventService } from '../ProjectsOrchestrationEventService';
import { WorkItemsModel } from '../../../database/models/WorkItemsModel';
import { TaskLifecycleOrchestrationService } from '../TaskLifecycleOrchestrationService';

const transition = (payload: Record<string, unknown>) => ({
  id: 'transition-1', task_id: 'task-1', event_type: 'projects.task.transitioned', attempts: 1,
  payload: { fromLane: 'backlog', toLane: 'todo', ...payload },
}) as any;

describe('ProjectsOrchestrationEventService', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('dispatches the exact committed lane entry and settles its event', async() => {
    jest.spyOn(ProjectsDomainEventOutbox, 'claim').mockResolvedValue([
      transition({ laneAutomated: true, laneEntryId: 'lane-entry-7' }),
    ]);
    const complete = jest.spyOn(ProjectsDomainEventOutbox, 'complete').mockResolvedValue(true);
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue({ id: 'task-1', status: 'todo' } as any);
    const lifecycle = jest.spyOn(TaskLifecycleOrchestrationService, 'handleCommittedTransition').mockResolvedValue();
    const dispatchLane = jest.fn<(id: string) => Promise<unknown>>().mockResolvedValue({ status: 'running' });

    await expect(new ProjectsOrchestrationEventService('owner-1', dispatchLane).drain())
      .resolves.toEqual({ completed: 1, retried: 0, unhandled: 0 });
    expect(dispatchLane).toHaveBeenCalledTimes(1);
    expect(dispatchLane).toHaveBeenCalledWith('lane-entry-7');
    expect(complete).toHaveBeenCalledWith('transition-1', 'owner-1');
    expect(lifecycle).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), 'backlog', undefined);
  });

  it('settles an unautomated transition without launching a workflow', async() => {
    jest.spyOn(ProjectsDomainEventOutbox, 'claim').mockResolvedValue([
      transition({ laneAutomated: false, laneEntryId: 'lane-entry-8' }),
    ]);
    jest.spyOn(ProjectsDomainEventOutbox, 'complete').mockResolvedValue(true);
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue({ id: 'task-1', status: 'todo' } as any);
    jest.spyOn(TaskLifecycleOrchestrationService, 'handleCommittedTransition').mockResolvedValue();
    const dispatchLane = jest.fn<(id: string) => Promise<unknown>>();

    await expect(new ProjectsOrchestrationEventService('owner-1', dispatchLane).drain())
      .resolves.toEqual({ completed: 1, retried: 0, unhandled: 0 });
    expect(dispatchLane).not.toHaveBeenCalled();
  });

  it('returns a malformed or failed lane dispatch to the durable queue', async() => {
    jest.spyOn(ProjectsDomainEventOutbox, 'claim').mockResolvedValue([
      transition({ laneAutomated: true, laneEntryId: 'lane-entry-9' }),
    ]);
    const retry = jest.spyOn(ProjectsDomainEventOutbox, 'retry').mockResolvedValue(true);
    const dispatchLane = jest.fn<(id: string) => Promise<unknown>>().mockRejectedValue(new Error('runtime unavailable'));

    await expect(new ProjectsOrchestrationEventService('owner-1', dispatchLane).drain())
      .resolves.toEqual({ completed: 0, retried: 1, unhandled: 0 });
    expect(retry).toHaveBeenCalledWith(
      'transition-1', 'owner-1', 'runtime unavailable', expect.any(Date),
    );
  });

  it('does not run lifecycle reactions for a superseded task generation', async() => {
    jest.spyOn(ProjectsDomainEventOutbox, 'claim').mockResolvedValue([
      transition({ laneAutomated: true, laneEntryId: 'lane-entry-old', fromLane: 'todo', toLane: 'in_review' }),
    ]);
    jest.spyOn(ProjectsDomainEventOutbox, 'complete').mockResolvedValue(true);
    jest.spyOn(WorkItemsModel, 'getTask').mockResolvedValue({ id: 'task-1', status: 'done' } as any);
    const lifecycle = jest.spyOn(TaskLifecycleOrchestrationService, 'handleCommittedTransition').mockResolvedValue();

    await new ProjectsOrchestrationEventService('owner-1', async() => undefined).drain();
    expect(lifecycle).not.toHaveBeenCalled();
  });
});
