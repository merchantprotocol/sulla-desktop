import { ProjectsDomainEventOutbox } from '../infrastructure/ProjectsDomainEventOutbox';

import type { ProjectsDomainEventRecord } from './ProjectsRepositories';

export type ProjectsDomainEventHandler = (event: ProjectsDomainEventRecord) => Promise<void>;

/** Lease-backed, replay-safe dispatcher. Handlers must be idempotent by event id. */
export class ProjectsDomainEventDispatcher {
  private readonly handlers = new Map<string, ProjectsDomainEventHandler>();

  constructor(private readonly owner: string) {
    if (!owner.trim()) throw new Error('Projects domain-event dispatcher owner is required.');
  }

  register(eventType: string, handler: ProjectsDomainEventHandler): this {
    if (!eventType.trim()) throw new Error('Projects domain-event type is required.');
    this.handlers.set(eventType, handler);
    return this;
  }

  async drain(limit = 25): Promise<{ completed: number; retried: number; unhandled: number }> {
    const events = await ProjectsDomainEventOutbox.claim(this.owner, limit);
    let completed = 0;
    let retried = 0;
    let unhandled = 0;
    for (const event of events) {
      const handler = this.handlers.get(event.event_type);
      if (!handler) {
        unhandled++;
        await ProjectsDomainEventOutbox.retry(
          event.id, this.owner, `No handler registered for ${ event.event_type }`, new Date(Date.now() + 60_000),
        );
        continue;
      }
      try {
        await handler(event);
        if (await ProjectsDomainEventOutbox.complete(event.id, this.owner)) completed++;
      } catch (error) {
        retried++;
        const message = error instanceof Error ? error.message : String(error);
        const delayMs = Math.min(300_000, 1_000 * (2 ** Math.min(event.attempts, 8)));
        await ProjectsDomainEventOutbox.retry(event.id, this.owner, message, new Date(Date.now() + delayMs));
      }
    }
    return { completed, retried, unhandled };
  }
}
