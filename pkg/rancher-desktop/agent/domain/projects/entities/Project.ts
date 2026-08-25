import { DomainError } from '../errors';
import { ProjectId } from '../values';

export interface ProjectProps {
  id: ProjectId;
  title: string;
  archived?: boolean;
}

export class Project {
  readonly id: ProjectId;
  readonly title: string;
  readonly archived: boolean;

  constructor(props: ProjectProps) {
    const title = props.title.trim();
    if (!title) throw new DomainError('Project title is required');
    this.id = props.id;
    this.title = title;
    this.archived = props.archived ?? false;
    Object.freeze(this);
  }
}
