import { LaneEntryAutomationService } from '../../services/LaneEntryAutomationService';

import { ProjectsDomainEventDispatcher } from './ProjectsDomainEventDispatcher';

import type { ProjectsDomainEventRecord } from './ProjectsRepositories';

type LaneEntryDispatcher = (entryId: string) => Promise<unknown>;

/**
 * The single runtime boundary between committed Projects domain events and
 * orchestration side effects. Event handlers must remain replay-safe: a crash
 * after the side effect and before outbox settlement will invoke them again.
 */
export class ProjectsOrchestrationEventService {
  private readonly dispatcher: ProjectsDomainEventDispatcher;

  constructor(owner: string, dispatchLaneEntry: LaneEntryDispatcher = LaneEntryAutomationService.dispatchEntry) {
    this.dispatcher = new ProjectsDomainEventDispatcher(owner)
      .register('projects.task.transitioned', event => this.handleTaskTransitioned(event, dispatchLaneEntry));
  }

  drain(limit = 25): Promise<{ completed: number; retried: number; unhandled: number }> {
    return this.dispatcher.drain(limit);
  }

  private async handleTaskTransitioned(
    event: ProjectsDomainEventRecord,
    dispatchLaneEntry: LaneEntryDispatcher,
  ): Promise<void> {
    if (event.payload.laneAutomated !== true) return;
    const laneEntryId = event.payload.laneEntryId;
    if (typeof laneEntryId !== 'string' || !laneEntryId.trim()) {
      throw new Error(`Projects transition event ${ event.id } has no lane-entry identity.`);
    }
    await dispatchLaneEntry(laneEntryId);
  }
}

let service: ProjectsOrchestrationEventService | null = null;

export function getProjectsOrchestrationEventService(): ProjectsOrchestrationEventService {
  service ??= new ProjectsOrchestrationEventService(`projects-orchestration-${ process.pid }`);
  return service;
}
