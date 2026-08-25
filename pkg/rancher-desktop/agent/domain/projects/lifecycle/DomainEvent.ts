import { DomainError } from '../errors';
import { ArtifactGeneration, TaskId } from '../values';

export interface DomainEventProps<TPayload extends Readonly<Record<string, unknown>>> {
  id: string;
  type: string;
  taskId: TaskId;
  generation: ArtifactGeneration;
  occurredAt: Date;
  payload: TPayload;
}

export class DomainEvent<TPayload extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  readonly id: string;
  readonly type: string;
  readonly taskId: TaskId;
  readonly generation: ArtifactGeneration;
  readonly occurredAt: Date;
  readonly payload: TPayload;

  constructor(props: DomainEventProps<TPayload>) {
    if (!props.id.trim()) throw new DomainError('Domain event id is required');
    if (!props.type.trim()) throw new DomainError('Domain event type is required');
    if (Number.isNaN(props.occurredAt.getTime())) throw new DomainError('Domain event timestamp is invalid');
    this.id = props.id.trim();
    this.type = props.type.trim();
    this.taskId = props.taskId;
    this.generation = props.generation;
    this.occurredAt = new Date(props.occurredAt.getTime());
    this.payload = Object.freeze({ ...props.payload }) as TPayload;
    Object.freeze(this);
  }
}
