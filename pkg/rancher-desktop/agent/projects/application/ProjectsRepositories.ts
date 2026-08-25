export interface ProjectSnapshot {
  id:       string;
  title:    string;
  archived: boolean;
}

export interface EpicSnapshot {
  id:         string;
  project_id: string;
  title:      string;
  archived:   boolean;
}

export interface TaskSnapshot {
  id:         string;
  project_id: string;
  epic_id:    string | null;
  title:      string;
  status:     string;
  assignee:   string | null;
  labels:     string[];
  archived:   boolean;
}

export interface TaskCommentSnapshot {
  id:         string;
  task_id:    string;
  body:       string;
  author:     string | null;
  created_at: string;
}

export interface ProjectsProjectRepository {
  get(id: string): Promise<ProjectSnapshot | null>;
}

export interface ProjectsEpicRepository {
  get(id: string): Promise<EpicSnapshot | null>;
}

export interface ProjectsTaskRepository {
  get(id: string): Promise<TaskSnapshot | null>;
  lock(id: string): Promise<TaskSnapshot | null>;
  compareAndSetLane(input: {
    taskId:          string;
    expectedLane:    string;
    destinationLane: string;
    actor:           string;
    assignee?:       string | null;
  }): Promise<TaskSnapshot | null>;
}

export interface ProjectsCommentRepository {
  append(input: {
    id:     string;
    taskId: string;
    body:   string;
    author: string;
  }): Promise<TaskCommentSnapshot>;
}

export interface ProjectsDomainEventRecord {
  id:              string;
  task_id:         string;
  generation:      number;
  generation_hash: string | null;
  event_type:      string;
  idempotency_key: string;
  payload:         Readonly<Record<string, unknown>>;
  status:          'pending' | 'processing' | 'completed';
  attempts:        number;
  available_at:    string;
  lease_owner:     string | null;
  leased_until:    string | null;
  last_error:      string | null;
  occurred_at:     string;
  created_at:      string;
  updated_at:      string | null;
  completed_at:    string | null;
}

export interface ProjectsDomainEventRepository {
  append(input: {
    id:              string;
    taskId:          string;
    generation:      number;
    generationHash?: string | null;
    eventType:       string;
    idempotencyKey:  string;
    payload:         Readonly<Record<string, unknown>>;
    occurredAt:      Date;
  }): Promise<ProjectsDomainEventRecord>;
}

/** Every repository in this object is scoped to the same database transaction. */
export interface ProjectsRepositories {
  projects: ProjectsProjectRepository;
  epics:    ProjectsEpicRepository;
  tasks:    ProjectsTaskRepository;
  comments: ProjectsCommentRepository;
  events:   ProjectsDomainEventRepository;
}
