import { DomainError } from '../errors';
import { Task } from '../entities';
import { DomainEvent } from './DomainEvent';

export type TransitionSource = 'tool' | 'ipc' | 'heartbeat' | 'routine' | 'dispatcher' | 'system';

export class LifecycleTransition {
  readonly from: Task;
  readonly to: Task;
  readonly actor: string;
  readonly source: TransitionSource;

  constructor(from: Task, to: Task, actor: string, source: TransitionSource) {
    if (!from.id.equals(to.id)) throw new DomainError('A lifecycle transition cannot change task identity');
    const sameEpic = from.epicId === null ? to.epicId === null : from.epicId.equals(to.epicId);
    if (!from.projectId.equals(to.projectId) || !sameEpic) {
      throw new DomainError('A lifecycle transition cannot move a task between aggregates');
    }
    if (!actor.trim()) throw new DomainError('Lifecycle transition actor is required');
    if (from.lane.equals(to.lane)) throw new DomainError('Lifecycle transition must change lanes');
    this.from = from;
    this.to = to;
    this.actor = actor.trim();
    this.source = source;
    Object.freeze(this);
  }

  toEvent(id: string, occurredAt: Date): DomainEvent {
    return new DomainEvent({
      id,
      type: 'projects.task.transitioned',
      taskId: this.to.id,
      generation: this.to.artifactGeneration,
      occurredAt,
      payload: Object.freeze({
        actor: this.actor,
        source: this.source,
        fromLane: this.from.lane.value,
        toLane: this.to.lane.value,
        fromRole: this.from.semanticRole.value,
        toRole: this.to.semanticRole.value,
      }),
    });
  }
}
