import { DomainError } from '../errors';
import { EpicId, ProjectId } from '../values';

export interface EpicProps {
  id: EpicId;
  projectId: ProjectId;
  title: string;
  archived?: boolean;
}

export class Epic {
  readonly id: EpicId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archived: boolean;

  constructor(props: EpicProps) {
    const title = props.title.trim();
    if (!title) throw new DomainError('Epic title is required');
    this.id = props.id;
    this.projectId = props.projectId;
    this.title = title;
    this.archived = props.archived ?? false;
    Object.freeze(this);
  }
}
