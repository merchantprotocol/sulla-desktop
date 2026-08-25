import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ProjectsDomainEventOutbox } from '../../infrastructure/ProjectsDomainEventOutbox';
import { ProjectsOrchestrationEventService } from '../ProjectsOrchestrationEventService';

const transition = (payload: Record<string, unknown>) => ({
  id: 'transition-1', event_type: 'projects.task.transitioned', attempts: 1, payload,
}) as any;

describe('ProjectsOrchestrationEventService', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('dispatches the exact committed lane entry and settles its event', async() => {
    jest.spyOn(ProjectsDomainEventOutbox, 'claim').mockResolvedValue([
      transition({ laneAutomated: true, laneEntryId: 'lane-entry-7' }),
    ]);
    const complete = jest.spyOn(ProjectsDomainEventOutbox, 'complete').mockResolvedValue(true);
    const dispatchLane = jest.fn<(id: string) => Promise<unknown>>().mockResolvedValue({ status: 'running' });

    await expect(new ProjectsOrchestrationEventService('owner-1', dispatchLane).drain())
      .resolves.toEqual({ completed: 1, retried: 0, unhandled: 0 });
    expect(dispatchLane).toHaveBeenCalledTimes(1);
    expect(dispatchLane).toHaveBeenCalledWith('lane-entry-7');
    expect(complete).toHaveBeenCalledWith('transition-1', 'owner-1');
  });

  it('settles an unautomated transition without launching a workflow', async() => {
    jest.spyOn(ProjectsDomainEventOutbox, 'claim').mockResolvedValue([
      transition({ laneAutomated: false, laneEntryId: 'lane-entry-8' }),
    ]);
    jest.spyOn(ProjectsDomainEventOutbox, 'complete').mockResolvedValue(true);
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
});
