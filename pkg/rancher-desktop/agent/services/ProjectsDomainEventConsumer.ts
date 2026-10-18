import { randomUUID } from 'node:crypto';

import { getHeartbeatService } from './HeartbeatService';
import { getProjectsApplicationService } from '../projects/application/ProjectsApplicationService';

const POLL_INTERVAL_MS = 5_000;
const CONSUMER_ID = `desktop-heartbeat-${ randomUUID() }`;

let projectsDomainEventConsumerInstance: ProjectsDomainEventConsumer | null = null;

export function getProjectsDomainEventConsumer(): ProjectsDomainEventConsumer {
  projectsDomainEventConsumerInstance ??= new ProjectsDomainEventConsumer();

  return projectsDomainEventConsumerInstance;
}

/**
 * Bridges durable Projects domain events to process-local Desktop behavior.
 * Projects retains the event, lease, retry, and acknowledgement authority.
 */
export class ProjectsDomainEventConsumer {
  private initialized = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    this.initialized = true;
    this.poll();

    return Promise.resolve();
  }

  destroy(): void {
    this.initialized = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private scheduleNext(): void {
    if (!this.initialized) return;
    this.pollTimer = setTimeout(() => { this.poll() }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private async poll(): Promise<void> {
    if (!this.initialized || this.polling) return;
    this.polling = true;
    try {
      const projects = getProjectsApplicationService();
      const events = await projects.claimDomainEvents({
        consumerId:   CONSUMER_ID,
        eventTypes:   ['projects.human_comment_added'],
        limit:        25,
        leaseSeconds: 60,
      });

      for (const event of events) {
        try {
          if (event.event_type !== 'projects.human_comment_added' || !event.task_id) {
            throw new Error(`Unsupported Projects domain event: ${ event.event_type }`);
          }
          getHeartbeatService().requestWake(`human commented on task ${ event.task_id }`);
          await projects.completeDomainEvents([event.id], CONSUMER_ID);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          await projects.failDomainEvents([event.id], CONSUMER_ID, message).catch((failError) => {
            console.error('[ProjectsDomainEvents] Failed to release event lease', failError);
          });
        }
      }
    } catch (error) {
      console.error('[ProjectsDomainEvents] Poll failed', error);
    } finally {
      this.polling = false;
      this.scheduleNext();
    }
  }
}
