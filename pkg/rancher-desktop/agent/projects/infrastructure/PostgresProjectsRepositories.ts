import type {
  EpicSnapshot,
  ProjectSnapshot,
  ProjectsCommentRepository,
  ProjectsEpicRepository,
  ProjectsProjectRepository,
  ProjectsRepositories,
  ProjectsTaskRepository,
  TaskCommentSnapshot,
  TaskSnapshot,
} from '../application/ProjectsRepositories';
import type { QueryResultRow } from 'pg';

export interface ProjectsSqlClient {
  query<T extends QueryResultRow = any>(text: string, values?: any[]): Promise<{ rows: T[] }>;
}

function task(row: TaskSnapshot | undefined): TaskSnapshot | null {
  if (!row) return null;
  return { ...row, labels: row.labels ?? [] };
}

class PostgresProjectRepository implements ProjectsProjectRepository {
  constructor(private readonly client: ProjectsSqlClient) {}

  async get(id: string): Promise<ProjectSnapshot | null> {
    const result = await this.client.query<ProjectSnapshot>(
      'SELECT id, title, archived FROM work_projects WHERE id = $1 LIMIT 1', [id],
    );
    return result.rows[0] ?? null;
  }
}

class PostgresEpicRepository implements ProjectsEpicRepository {
  constructor(private readonly client: ProjectsSqlClient) {}

  async get(id: string): Promise<EpicSnapshot | null> {
    const result = await this.client.query<EpicSnapshot>(
      'SELECT id, project_id, title, archived FROM work_epics WHERE id = $1 LIMIT 1', [id],
    );
    return result.rows[0] ?? null;
  }
}

class PostgresTaskRepository implements ProjectsTaskRepository {
  constructor(private readonly client: ProjectsSqlClient) {}

  async get(id: string): Promise<TaskSnapshot | null> {
    const result = await this.client.query<TaskSnapshot>(
      `SELECT id, project_id, epic_id, title, status, assignee, labels, archived
         FROM work_tasks WHERE id = $1 LIMIT 1`, [id],
    );
    return task(result.rows[0]);
  }

  async lock(id: string): Promise<TaskSnapshot | null> {
    const result = await this.client.query<TaskSnapshot>(
      `SELECT id, project_id, epic_id, title, status, assignee, labels, archived
         FROM work_tasks WHERE id = $1 FOR UPDATE`, [id],
    );
    return task(result.rows[0]);
  }

  async compareAndSetLane(input: {
    taskId:          string;
    expectedLane:    string;
    destinationLane: string;
    actor:           string;
    assignee?:       string | null;
  }): Promise<TaskSnapshot | null> {
    const result = await this.client.query<TaskSnapshot>(
      `UPDATE work_tasks
          SET status = $2,
              assignee = CASE WHEN $4::boolean THEN $5 ELSE assignee END,
              updated_at = now(),
              last_moved_at = now(),
              last_activity_at = now(),
              last_moved_by = $3
        WHERE id = $1 AND status = $6 AND archived = false
      RETURNING id, project_id, epic_id, title, status, assignee, labels, archived`,
      [
        input.taskId,
        input.destinationLane,
        input.actor,
        input.assignee !== undefined,
        input.assignee ?? null,
        input.expectedLane,
      ],
    );
    return task(result.rows[0]);
  }
}

class PostgresCommentRepository implements ProjectsCommentRepository {
  constructor(private readonly client: ProjectsSqlClient) {}

  async append(input: {
    id:     string;
    taskId: string;
    body:   string;
    author: string;
  }): Promise<TaskCommentSnapshot> {
    const result = await this.client.query<TaskCommentSnapshot>(
      `INSERT INTO work_task_comments (id, task_id, body, author)
       VALUES ($1, $2, $3, $4)
       RETURNING id, task_id, body, author, created_at`,
      [input.id, input.taskId, input.body, input.author],
    );
    if (!result.rows[0]) throw new Error('Projects comment insert returned no row.');
    return result.rows[0];
  }
}

export function createPostgresProjectsRepositories(client: ProjectsSqlClient): ProjectsRepositories {
  return {
    projects: new PostgresProjectRepository(client),
    epics:    new PostgresEpicRepository(client),
    tasks:    new PostgresTaskRepository(client),
    comments: new PostgresCommentRepository(client),
  };
}
