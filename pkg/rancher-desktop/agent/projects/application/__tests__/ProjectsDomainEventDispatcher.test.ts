import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ProjectsDomainEventOutbox } from '../../infrastructure/ProjectsDomainEventOutbox';
import { ProjectsDomainEventDispatcher } from '../ProjectsDomainEventDispatcher';

const event = { id: 'event-1', event_type: 'projects.task.review-requested', attempts: 1 } as any;

describe('ProjectsDomainEventDispatcher', () => {
  afterEach(() => { jest.restoreAllMocks() });

  it('settles an exact leased event after its idempotent handler succeeds', async() => {
    jest.spyOn(ProjectsDomainEventOutbox, 'claim').mockResolvedValue([event]);
    const complete = jest.spyOn(ProjectsDomainEventOutbox, 'complete').mockResolvedValue(true);
    const handler = jest.fn<(claimed: typeof event) => Promise<void>>().mockResolvedValue();
    const dispatcher = new ProjectsDomainEventDispatcher('dispatcher-1').register(event.event_type, handler);

    await expect(dispatcher.drain()).resolves.toEqual({ completed: 1, retried: 0, unhandled: 0 });
    expect(handler).toHaveBeenCalledWith(event);
    expect(complete).toHaveBeenCalledWith(event.id, 'dispatcher-1');
  });

  it('returns failures to the durable queue with bounded backoff', async() => {
    jest.spyOn(ProjectsDomainEventOutbox, 'claim').mockResolvedValue([event]);
    const retry = jest.spyOn(ProjectsDomainEventOutbox, 'retry').mockResolvedValue(true);
    const dispatcher = new ProjectsDomainEventDispatcher('dispatcher-1')
      .register(event.event_type, async() => { throw new Error('transient'); });

    await expect(dispatcher.drain()).resolves.toEqual({ completed: 0, retried: 1, unhandled: 0 });
    expect(retry).toHaveBeenCalledWith(event.id, 'dispatcher-1', 'transient', expect.any(Date));
  });
});
