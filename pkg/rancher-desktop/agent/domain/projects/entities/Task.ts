import { DomainError } from '../errors';
import { ArtifactGeneration, EpicId, LaneKey, ProjectId, SemanticRole, TaskId } from '../values';

export interface TaskProps {
  id: TaskId;
  projectId: ProjectId;
  epicId: EpicId | null;
  title: string;
  lane: LaneKey;
  semanticRole: SemanticRole;
  artifactGeneration?: ArtifactGeneration;
  assignee?: string | null;
  labels?: readonly string[];
  archived?: boolean;
}

export class Task {
  readonly id: TaskId;
  readonly projectId: ProjectId;
  readonly epicId: EpicId | null;
  readonly title: string;
  readonly lane: LaneKey;
  readonly semanticRole: SemanticRole;
  readonly artifactGeneration: ArtifactGeneration;
  readonly assignee: string | null;
  readonly labels: readonly string[];
  readonly archived: boolean;

  constructor(props: TaskProps) {
    const title = props.title.trim();
    if (!title) throw new DomainError('Task title is required');
    this.id = props.id;
    this.projectId = props.projectId;
    this.epicId = props.epicId;
    this.title = title;
    this.lane = props.lane;
    this.semanticRole = props.semanticRole;
    this.artifactGeneration = props.artifactGeneration ?? ArtifactGeneration.initial();
    this.assignee = props.assignee?.trim() || null;
    this.labels = Object.freeze([...(props.labels ?? [])]);
    this.archived = props.archived ?? false;
    Object.freeze(this);
  }

  moveTo(lane: LaneKey, semanticRole: SemanticRole): Task {
    if (this.archived) throw new DomainError('Archived tasks cannot transition');
    return new Task({ ...this, lane, semanticRole });
  }
}
