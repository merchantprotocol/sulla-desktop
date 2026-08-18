/**
 * WorkItemsModel — Projects → epics → tasks (+ comments) in PostgreSQL.
 *
 * This is the operator Projects. It is NOT the filesystem ProjectRegistry
 * (those are PROJECT.md PRDs under ~/sulla/projects/). It is NOT CRM —
 * CRM belongs in Sulla Cloud. Rows here are the structured agenda:
 * what needs to be done, what stage it is in, last time it moved.
 *
 * Soft-archive only (never hard-delete). SCHEMA-ONLY migration 0044;
 * install-local ledger markdown is imported at runtime by
 * WorkItemsImportSeeder (no user data in shipped code).
 *
 * DUAL-STORE NOTE: reads and writes ONLY Postgres — no Redis hash.
 */

import { postgresClient } from '../PostgresClient';

// ── Types ──────────────────────────────────────────────────────────────

export type WorkItemKind = 'project' | 'epic' | 'task';

export interface WorkProjectRecord {
  id:              string;
  slug:            string;
  title:           string;
  description:     string;
  outcome_metric:  string | null;
  status:          string;
  priority:        string;
  owner:           string | null;
  source:          string | null;
  source_path:     string | null;
  github_repo:     string | null;
  due_at:          string | null;
  created_at:      string;
  updated_at:      string | null;
  last_moved_at:   string;
  archived:        boolean;
}

export interface WorkEpicRecord {
  id:            string;
  project_id:    string;
  slug:          string | null;
  title:         string;
  description:   string;
  status:        string;
  priority:      string;
  position:      number;
  due_at:        string | null;
  source:        string | null;
  source_ref:    string | null;
  created_at:    string;
  updated_at:    string | null;
  last_moved_at: string;
  archived:      boolean;
}

export interface WorkTaskRecord {
  id:            string;
  project_id:    string;
  epic_id:       string | null;
  parent_id:     string | null;
  slug:          string | null;
  title:         string;
  description:   string;
  status:        string;
  priority:      string;
  due_at:        string | null;
  github_issue:  string | null;
  assignee:      string | null;
  labels:        string[] | null;
  position:      number;
  source:        string | null;
  source_ref:    string | null;
  created_at:    string;
  updated_at:    string | null;
  last_moved_at: string;
  completed_at:  string | null;
  archived:      boolean;
}

export interface WorkCommentRecord {
  id:         string;
  task_id:    string;
  body:       string;
  author:     string | null;
  created_at: string;
  updated_at: string | null;
  archived:   boolean;
}

export type WorkActivityKind =
  | 'comment'
  | 'task_created'
  | 'task_updated'
  | 'task_moved'
  | 'epic_created'
  | 'epic_updated'
  | 'project_created'
  | 'project_updated';

/**
 * A single row in the unified Projects activity feed. Rows are synthesized from
 * comments plus the created_at / last_moved_at / updated_at timestamps on
 * projects, epics and tasks — there is no separate audit table, so each item
 * contributes at most one row per event kind (its most recent create/move/edit).
 */
export interface WorkActivityRecord {
  id:            string;               // unique per feed row (kind-prefixed for non-comments)
  kind:          WorkActivityKind;
  activity_at:   string;               // the moment this event happened (sort key)
  created_at:    string;               // alias of activity_at, kept for renderers that format it
  body:          string | null;        // comment text; null for lifecycle events
  author:        string | null;        // comment author; null for lifecycle events
  task_id:       string | null;        // null for epic/project-level events
  task_title:    string | null;
  task_status:   string;               // status of the subject item (task, or epic/project)
  task_priority: string;
  project_id:    string;
  project_title: string;
  project_slug:  string;
  epic_id:       string | null;
  epic_title:    string | null;
}

export interface SearchHit {
  kind:     WorkItemKind;
  id:       string;
  title:    string;
  status:   string;
  priority: string;
  archived: boolean;
}

export interface UpsertProjectInput {
  id?:              string;
  slug?:            string;
  title:            string;
  description?:     string;
  outcome_metric?:  string | null;
  status?:          string;
  priority?:        string;
  owner?:           string | null;
  due_at?:          string | null;
  source?:          string | null;
  source_ref?:      string | null;
  source_path?:     string | null;
  github_repo?:     string | null;
}

export interface UpdateProjectInput {
  slug?:            string;
  title?:           string;
  description?:     string;
  outcome_metric?:  string | null;
  status?:          string;
  priority?:        string;
  owner?:           string | null;
  due_at?:          string | null;
  source?:          string | null;
  source_path?:     string | null;
  github_repo?:     string | null;
}

export interface UpsertEpicInput {
  id?:           string;
  project_id:    string;
  slug?:         string;
  title:         string;
  description?:  string;
  status?:       string;
  priority?:     string;
  position?:     number;
  due_at?:       string | null;
  source?:       string | null;
  source_ref?:   string | null;
}

export interface UpdateEpicInput {
  project_id?:   string;
  slug?:         string;
  title?:        string;
  description?:  string;
  status?:       string;
  priority?:     string;
  position?:     number;
  due_at?:       string | null;
  source?:       string | null;
  source_ref?:   string | null;
}

export interface UpsertTaskInput {
  id?:            string;
  project_id?:    string;
  epic_id?:       string | null;
  parent_id?:     string | null;
  slug?:          string;
  title:          string;
  description?:   string;
  status?:        string;
  priority?:      string;
  assignee?:      string | null;
  due_at?:        string | null;
  labels?:        string[];
  github_issue?:  string | null;
  position?:      number;
  source?:        string | null;
  source_ref?:    string | null;
}

export interface UpdateTaskInput {
  epic_id?:       string | null;
  parent_id?:     string | null;
  slug?:          string | null;
  title?:         string;
  description?:   string;
  status?:        string;
  priority?:      string;
  assignee?:      string | null;
  due_at?:        string | null;
  labels?:        string[];
  github_issue?:  string | null;
  position?:      number;
  source?:        string | null;
  source_ref?:    string | null;
}

export interface AddCommentInput {
  id?:      string;
  task_id:  string;
  body:     string;
  author?:  string;
}

export interface ListOpts {
  status?:      string;
  priority?:    string;
  includeDone?: boolean;
  limit?:       number;
}

export interface ListActivityOpts {
  projectId?: string;
  author?:    string;
  limit?:     number;
}

export interface ListEpicsOpts extends ListOpts {
  projectId?: string;
}

export interface ListTasksOpts extends ListOpts {
  projectId?: string;
  epicId?:    string;
  parentId?:  string;
  assignee?:  string;
}

export interface SearchOpts {
  query:             string;
  kind?:             WorkItemKind | string;
  includeArchived?:  boolean;
  limit?:            number;
}

// ── Tiny-ID generator (4-char) — same alphabet as observations/rules ──

function generateTinyId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

const CLOSED_STATUSES = `status IN ('done', 'cancelled', 'parked')`;

const PRIORITY_RANK = `
  CASE priority
    WHEN '🔴' THEN 0 WHEN 'critical' THEN 0 WHEN 'p0' THEN 0 WHEN 'P0' THEN 0
    WHEN 'p1' THEN 1 WHEN 'P1' THEN 1 WHEN 'high' THEN 1
    WHEN '🟡' THEN 2 WHEN 'p2' THEN 2 WHEN 'P2' THEN 2 WHEN 'medium' THEN 2
    WHEN 'p3' THEN 3 WHEN 'P3' THEN 3
    WHEN '⚪' THEN 4 WHEN 'low' THEN 4 WHEN 'p4' THEN 4 WHEN 'P4' THEN 4
    ELSE 5
  END ASC`;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'these', 'those',
  'have', 'has', 'had', 'about', 'into', 'from', 'when', 'where', 'what', 'which', 'who',
  'how', 'why', 'did', 'does', 'doing', 'will', 'would', 'could', 'should', 'can', 'not',
  'you', 'your', 'our', 'his', 'her', 'its', 'their', 'them', 'they', 'all', 'any', 'some',
  'just', 'than', 'then', 'too', 'very', 'out', 'now', 'get', 'got', 'been', 'being',
]);

function tokenizeQuery(query: string): string[] {
  return Array.from(new Set(
    (query.toLowerCase().match(/[a-z0-9_-]+/g) ?? [])
      .filter(w => w.length >= 3 && !STOPWORDS.has(w)),
  ));
}

function isClosedStatus(status: string | undefined): boolean {
  return status === 'done' || status === 'cancelled' || status === 'parked';
}

// ── Model ──────────────────────────────────────────────────────────────

export class WorkItemsModel {
  private static readonly PROJECTS = 'work_projects';
  private static readonly EPICS    = 'work_epics';
  private static readonly TASKS    = 'work_tasks';
  private static readonly COMMENTS = 'work_task_comments';

  // ──────────────────────────────────────────────
  // Table bootstrap (idempotent) — mirrors migration 0044
  // ──────────────────────────────────────────────

  static async ensureTables(): Promise<void> {
    try {
      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ WorkItemsModel.PROJECTS } (
          id              TEXT        PRIMARY KEY,
          slug            TEXT        NOT NULL UNIQUE,
          title           TEXT        NOT NULL,
          description     TEXT        NOT NULL DEFAULT '',
          outcome_metric  TEXT,
          status          TEXT        NOT NULL DEFAULT 'working',
          priority        TEXT        NOT NULL DEFAULT 'p2',
          owner           TEXT,
          source          TEXT,
          source_path     TEXT,
          github_repo     TEXT,
          due_at          TIMESTAMPTZ,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ,
          last_moved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          archived        BOOLEAN     NOT NULL DEFAULT false
        )
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_work_projects_board
          ON ${ WorkItemsModel.PROJECTS } (archived, status, priority, last_moved_at ASC)
      `);

      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ WorkItemsModel.EPICS } (
          id              TEXT        PRIMARY KEY,
          project_id      TEXT        NOT NULL REFERENCES ${ WorkItemsModel.PROJECTS }(id),
          slug            TEXT,
          title           TEXT        NOT NULL,
          description     TEXT        NOT NULL DEFAULT '',
          status          TEXT        NOT NULL DEFAULT 'working',
          priority        TEXT        NOT NULL DEFAULT 'p2',
          position        INTEGER     NOT NULL DEFAULT 0,
          due_at          TIMESTAMPTZ,
          source          TEXT,
          source_ref      TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ,
          last_moved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          archived        BOOLEAN     NOT NULL DEFAULT false
        )
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_work_epics_project
          ON ${ WorkItemsModel.EPICS } (project_id, archived, position, status)
      `);
      await postgresClient.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_epics_project_slug
          ON ${ WorkItemsModel.EPICS } (project_id, slug)
          WHERE slug IS NOT NULL
      `);

      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ WorkItemsModel.TASKS } (
          id              TEXT        PRIMARY KEY,
          project_id      TEXT        NOT NULL REFERENCES ${ WorkItemsModel.PROJECTS }(id),
          epic_id         TEXT        REFERENCES ${ WorkItemsModel.EPICS }(id),
          parent_id       TEXT        REFERENCES ${ WorkItemsModel.TASKS }(id),
          slug            TEXT,
          title           TEXT        NOT NULL,
          description     TEXT        NOT NULL DEFAULT '',
          status          TEXT        NOT NULL DEFAULT 'todo',
          priority        TEXT        NOT NULL DEFAULT 'p2',
          due_at          TIMESTAMPTZ,
          github_issue    TEXT,
          assignee        TEXT,
          labels          TEXT[],
          position        INTEGER     NOT NULL DEFAULT 0,
          source          TEXT,
          source_ref      TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ,
          last_moved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          completed_at    TIMESTAMPTZ,
          archived        BOOLEAN     NOT NULL DEFAULT false
        )
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_work_tasks_epic
          ON ${ WorkItemsModel.TASKS } (epic_id, archived, status, position)
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_work_tasks_project
          ON ${ WorkItemsModel.TASKS } (project_id, archived, status, priority, due_at)
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_work_tasks_parent
          ON ${ WorkItemsModel.TASKS } (parent_id) WHERE parent_id IS NOT NULL
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_work_tasks_due
          ON ${ WorkItemsModel.TASKS } (archived, due_at)
          WHERE due_at IS NOT NULL AND archived = false
      `);
      await postgresClient.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_tasks_epic_slug
          ON ${ WorkItemsModel.TASKS } (epic_id, slug)
          WHERE slug IS NOT NULL
      `);

      await postgresClient.query(`
        CREATE TABLE IF NOT EXISTS ${ WorkItemsModel.COMMENTS } (
          id              TEXT        PRIMARY KEY,
          task_id         TEXT        NOT NULL REFERENCES ${ WorkItemsModel.TASKS }(id),
          body            TEXT        NOT NULL,
          author          TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ,
          archived        BOOLEAN     NOT NULL DEFAULT false
        )
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_work_task_comments_task
          ON ${ WorkItemsModel.COMMENTS } (task_id, archived, created_at ASC)
      `);

      try {
        await postgresClient.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        await postgresClient.query(`
          CREATE INDEX IF NOT EXISTS idx_work_projects_title_trgm
            ON ${ WorkItemsModel.PROJECTS } USING gin (title gin_trgm_ops)
        `);
        await postgresClient.query(`
          CREATE INDEX IF NOT EXISTS idx_work_epics_title_trgm
            ON ${ WorkItemsModel.EPICS } USING gin (title gin_trgm_ops)
        `);
        await postgresClient.query(`
          CREATE INDEX IF NOT EXISTS idx_work_tasks_title_trgm
            ON ${ WorkItemsModel.TASKS } USING gin (title gin_trgm_ops)
        `);
      } catch (trgmErr) {
        console.warn('[WorkItemsModel] pg_trgm index unavailable (non-fatal):', trgmErr);
      }
    } catch (err) {
      console.error('[WorkItemsModel] Failed to ensure tables:', err);
    }
  }

  /** Alias — ObservationsModel/RulesModel style. */
  static async ensureTable(): Promise<void> {
    return WorkItemsModel.ensureTables();
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  private static async uniqueId(table: string): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const id = generateTinyId();
      const rows = await postgresClient.query<{ id: string }>(
        `SELECT id FROM ${ table } WHERE id = $1 LIMIT 1`,
        [id],
      );
      if (rows.length === 0) return id;
    }
    return `${ generateTinyId() }${ generateTinyId() }`;
  }

  private static async requireEpic(epicId: string): Promise<WorkEpicRecord> {
    const epic = await WorkItemsModel.getEpic(epicId);
    if (!epic) throw new Error(`No epic found with id: ${ epicId }`);
    return epic;
  }

  private static pushClosedFilter(conds: string[], opts: ListOpts): void {
    if (opts.status) return;
    if (!opts.includeDone) conds.push(`NOT (${ CLOSED_STATUSES })`);
  }

  // ──────────────────────────────────────────────
  // Projects
  // ──────────────────────────────────────────────

  static async getProject(id: string): Promise<WorkProjectRecord | null> {
    const rows = await postgresClient.query<WorkProjectRecord>(
      `SELECT * FROM ${ WorkItemsModel.PROJECTS } WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  static async getProjectBySlug(slug: string): Promise<WorkProjectRecord | null> {
    const rows = await postgresClient.query<WorkProjectRecord>(
      `SELECT * FROM ${ WorkItemsModel.PROJECTS }
        WHERE slug = $1 AND archived = false
        LIMIT 1`,
      [slug],
    );
    return rows[0] ?? null;
  }

  static async upsertProject(input: UpsertProjectInput): Promise<WorkProjectRecord> {
    const slug = (input.slug || slugify(input.title)).slice(0, 80);
    const existing = await WorkItemsModel.getProjectBySlug(slug);
    if (existing) {
      return (await WorkItemsModel.updateProject(existing.id, {
        title:          input.title,
        description:    input.description,
        outcome_metric: input.outcome_metric,
        status:         input.status,
        priority:       input.priority,
        owner:          input.owner,
        due_at:         input.due_at,
        source:         input.source,
        source_path:    input.source_path ?? input.source_ref,
        github_repo:    input.github_repo,
      })) ?? existing;
    }

    const id = input.id || await WorkItemsModel.uniqueId(WorkItemsModel.PROJECTS);
    const rows = await postgresClient.query<WorkProjectRecord>(
      `INSERT INTO ${ WorkItemsModel.PROJECTS }
         (id, slug, title, description, outcome_metric, status, priority,
          owner, source, source_path, github_repo, due_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        slug,
        input.title,
        input.description ?? '',
        input.outcome_metric ?? null,
        input.status ?? 'working',
        input.priority ?? 'p2',
        input.owner ?? null,
        input.source ?? null,
        input.source_path ?? input.source_ref ?? null,
        input.github_repo ?? null,
        input.due_at ?? null,
      ],
    );
    return rows[0];
  }

  static async updateProject(id: string, changes: UpdateProjectInput): Promise<WorkProjectRecord | null> {
    const existing = await WorkItemsModel.getProject(id);
    if (!existing) return null;

    const setClauses: string[] = ['updated_at = now()'];
    const values: any[] = [];
    let idx = 1;
    let moved = false;

    const assign = (col: string, val: any) => {
      setClauses.push(`${ col } = $${ idx++ }`);
      values.push(val);
    };

    if (changes.slug           !== undefined) assign('slug', changes.slug);
    if (changes.title          !== undefined) assign('title', changes.title);
    if (changes.description    !== undefined) assign('description', changes.description);
    if (changes.outcome_metric !== undefined) assign('outcome_metric', changes.outcome_metric);
    if (changes.status         !== undefined) { assign('status', changes.status); moved = true; }
    if (changes.priority       !== undefined) { assign('priority', changes.priority); moved = true; }
    if (changes.owner          !== undefined) assign('owner', changes.owner);
    if (changes.due_at         !== undefined) { assign('due_at', changes.due_at); moved = true; }
    if (changes.source         !== undefined) assign('source', changes.source);
    if (changes.source_path    !== undefined) assign('source_path', changes.source_path);
    if (changes.github_repo    !== undefined) assign('github_repo', changes.github_repo);

    if (moved) setClauses.push('last_moved_at = now()');
    if (setClauses.length === 1) return existing;

    values.push(id);
    const rows = await postgresClient.query<WorkProjectRecord>(
      `UPDATE ${ WorkItemsModel.PROJECTS } SET ${ setClauses.join(', ') }
        WHERE id = $${ idx } RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  static async listProjects(opts: ListOpts = {}): Promise<WorkProjectRecord[]> {
    const conds = ['archived = false'];
    const values: any[] = [];
    let idx = 1;
    WorkItemsModel.pushClosedFilter(conds, opts);
    if (opts.status)   { conds.push(`status = $${ idx++ }`);   values.push(opts.status); }
    if (opts.priority) { conds.push(`priority = $${ idx++ }`); values.push(opts.priority); }
    const limit = opts.limit ?? 50;
    values.push(limit);
    return postgresClient.query<WorkProjectRecord>(
      `SELECT * FROM ${ WorkItemsModel.PROJECTS }
        WHERE ${ conds.join(' AND ') }
        ORDER BY ${ PRIORITY_RANK }, last_moved_at ASC, slug ASC
        LIMIT $${ idx }`,
      values,
    );
  }

  // ──────────────────────────────────────────────
  // Epics
  // ──────────────────────────────────────────────

  static async getEpic(id: string): Promise<WorkEpicRecord | null> {
    const rows = await postgresClient.query<WorkEpicRecord>(
      `SELECT * FROM ${ WorkItemsModel.EPICS } WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  static async upsertEpic(input: UpsertEpicInput): Promise<WorkEpicRecord> {
    const project = await WorkItemsModel.getProject(input.project_id);
    if (!project) throw new Error(`No project found with id: ${ input.project_id }`);

    const slug = input.slug ? input.slug.slice(0, 80) : slugify(input.title);
    if (slug) {
      const existing = await postgresClient.query<WorkEpicRecord>(
        `SELECT * FROM ${ WorkItemsModel.EPICS }
          WHERE project_id = $1 AND slug = $2 AND archived = false
          LIMIT 1`,
        [input.project_id, slug],
      );
      if (existing[0]) {
        return (await WorkItemsModel.updateEpic(existing[0].id, {
          title:       input.title,
          description: input.description,
          status:      input.status,
          priority:    input.priority,
          position:    input.position,
          due_at:      input.due_at,
          source:      input.source,
          source_ref:  input.source_ref,
        })) ?? existing[0];
      }
    }

    const id = input.id || await WorkItemsModel.uniqueId(WorkItemsModel.EPICS);
    const rows = await postgresClient.query<WorkEpicRecord>(
      `INSERT INTO ${ WorkItemsModel.EPICS }
         (id, project_id, slug, title, description, status, priority,
          position, due_at, source, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        id,
        input.project_id,
        slug || null,
        input.title,
        input.description ?? '',
        input.status ?? 'working',
        input.priority ?? 'p2',
        input.position ?? 0,
        input.due_at ?? null,
        input.source ?? null,
        input.source_ref ?? null,
      ],
    );
    return rows[0];
  }

  static async updateEpic(id: string, changes: UpdateEpicInput): Promise<WorkEpicRecord | null> {
    const existing = await WorkItemsModel.getEpic(id);
    if (!existing) return null;

    if (changes.project_id) {
      const project = await WorkItemsModel.getProject(changes.project_id);
      if (!project) throw new Error(`No project found with id: ${ changes.project_id }`);
    }

    const setClauses: string[] = ['updated_at = now()'];
    const values: any[] = [];
    let idx = 1;
    let moved = false;

    const assign = (col: string, val: any) => {
      setClauses.push(`${ col } = $${ idx++ }`);
      values.push(val);
    };

    if (changes.project_id  !== undefined) { assign('project_id', changes.project_id); moved = true; }
    if (changes.slug        !== undefined) assign('slug', changes.slug);
    if (changes.title       !== undefined) assign('title', changes.title);
    if (changes.description !== undefined) assign('description', changes.description);
    if (changes.status      !== undefined) { assign('status', changes.status); moved = true; }
    if (changes.priority    !== undefined) { assign('priority', changes.priority); moved = true; }
    if (changes.position    !== undefined) assign('position', changes.position);
    if (changes.due_at      !== undefined) { assign('due_at', changes.due_at); moved = true; }
    if (changes.source      !== undefined) assign('source', changes.source);
    if (changes.source_ref  !== undefined) assign('source_ref', changes.source_ref);

    if (moved) setClauses.push('last_moved_at = now()');
    if (setClauses.length === 1) return existing;

    values.push(id);
    const rows = await postgresClient.query<WorkEpicRecord>(
      `UPDATE ${ WorkItemsModel.EPICS } SET ${ setClauses.join(', ') }
        WHERE id = $${ idx } RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  static async listEpics(opts: ListEpicsOpts = {}): Promise<WorkEpicRecord[]> {
    const conds = ['archived = false'];
    const values: any[] = [];
    let idx = 1;
    WorkItemsModel.pushClosedFilter(conds, opts);
    if (opts.projectId) { conds.push(`project_id = $${ idx++ }`); values.push(opts.projectId); }
    if (opts.status)    { conds.push(`status = $${ idx++ }`);     values.push(opts.status); }
    if (opts.priority)  { conds.push(`priority = $${ idx++ }`);   values.push(opts.priority); }
    const limit = opts.limit ?? 50;
    values.push(limit);
    return postgresClient.query<WorkEpicRecord>(
      `SELECT * FROM ${ WorkItemsModel.EPICS }
        WHERE ${ conds.join(' AND ') }
        ORDER BY position ASC, ${ PRIORITY_RANK }, last_moved_at ASC
        LIMIT $${ idx }`,
      values,
    );
  }

  // ──────────────────────────────────────────────
  // Tasks
  // ──────────────────────────────────────────────

  static async getTask(id: string): Promise<WorkTaskRecord | null> {
    const rows = await postgresClient.query<WorkTaskRecord>(
      `SELECT * FROM ${ WorkItemsModel.TASKS } WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  static async insertTask(input: UpsertTaskInput): Promise<WorkTaskRecord> {
    if (!input.epic_id) throw new Error('epic_id is required to create a task.');
    const epic = await WorkItemsModel.requireEpic(input.epic_id);
    const projectId = input.project_id || epic.project_id;
    const slug = input.slug ? input.slug.slice(0, 80) : null;
    const status = input.status ?? 'working';
    const id = input.id || await WorkItemsModel.uniqueId(WorkItemsModel.TASKS);

    const rows = await postgresClient.query<WorkTaskRecord>(
      `INSERT INTO ${ WorkItemsModel.TASKS }
         (id, project_id, epic_id, parent_id, slug, title, description, status,
          priority, due_at, github_issue, assignee, labels, position, source,
          source_ref, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [
        id,
        projectId,
        input.epic_id,
        input.parent_id ?? null,
        slug,
        input.title,
        input.description ?? '',
        status,
        input.priority ?? 'p2',
        input.due_at ?? null,
        input.github_issue ?? null,
        input.assignee ?? null,
        input.labels ?? [],
        input.position ?? 0,
        input.source ?? null,
        input.source_ref ?? null,
        isClosedStatus(status) ? new Date().toISOString() : null,
      ],
    );
    return rows[0];
  }

  static async upsertTask(input: UpsertTaskInput): Promise<WorkTaskRecord> {
    if (!input.epic_id) throw new Error('epic_id is required to create a task.');
    const slug = input.slug ? input.slug.slice(0, 80) : null;
    if (slug) {
      const existing = await postgresClient.query<WorkTaskRecord>(
        `SELECT * FROM ${ WorkItemsModel.TASKS }
          WHERE epic_id = $1 AND slug = $2 AND archived = false
          LIMIT 1`,
        [input.epic_id, slug],
      );
      if (existing[0]) {
        return (await WorkItemsModel.updateTask(existing[0].id, {
          parent_id:    input.parent_id,
          title:        input.title,
          description:  input.description,
          status:       input.status,
          priority:     input.priority,
          assignee:     input.assignee,
          due_at:       input.due_at,
          labels:       input.labels,
          github_issue: input.github_issue,
          position:     input.position,
          source:       input.source,
          source_ref:   input.source_ref,
        })) ?? existing[0];
      }
    }
    return WorkItemsModel.insertTask(input);
  }

  static async updateTask(id: string, changes: UpdateTaskInput): Promise<WorkTaskRecord | null> {
    const existing = await WorkItemsModel.getTask(id);
    if (!existing) return null;

    let nextProjectId: string | undefined;
    if (changes.epic_id) {
      const epic = await WorkItemsModel.requireEpic(changes.epic_id);
      nextProjectId = epic.project_id;
    }

    const setClauses: string[] = ['updated_at = now()'];
    const values: any[] = [];
    let idx = 1;
    let moved = false;

    const assign = (col: string, val: any) => {
      setClauses.push(`${ col } = $${ idx++ }`);
      values.push(val);
    };

    if (changes.epic_id      !== undefined) { assign('epic_id', changes.epic_id); moved = true; }
    if (nextProjectId        !== undefined) assign('project_id', nextProjectId);
    if (changes.parent_id    !== undefined) { assign('parent_id', changes.parent_id); moved = true; }
    if (changes.slug         !== undefined) assign('slug', changes.slug);
    if (changes.title        !== undefined) assign('title', changes.title);
    if (changes.description  !== undefined) assign('description', changes.description);
    if (changes.status       !== undefined) { assign('status', changes.status); moved = true; }
    if (changes.priority     !== undefined) { assign('priority', changes.priority); moved = true; }
    if (changes.assignee     !== undefined) { assign('assignee', changes.assignee); moved = true; }
    if (changes.due_at       !== undefined) { assign('due_at', changes.due_at); moved = true; }
    if (changes.labels       !== undefined) assign('labels', changes.labels);
    if (changes.github_issue !== undefined) assign('github_issue', changes.github_issue);
    if (changes.position     !== undefined) assign('position', changes.position);
    if (changes.source       !== undefined) assign('source', changes.source);
    if (changes.source_ref   !== undefined) assign('source_ref', changes.source_ref);

    if (changes.status !== undefined) {
      assign('completed_at', isClosedStatus(changes.status) ? new Date().toISOString() : null);
    }

    if (moved) setClauses.push('last_moved_at = now()');
    if (setClauses.length === 1) return existing;

    values.push(id);
    const rows = await postgresClient.query<WorkTaskRecord>(
      `UPDATE ${ WorkItemsModel.TASKS } SET ${ setClauses.join(', ') }
        WHERE id = $${ idx } RETURNING *`,
      values,
    );
    return rows[0] ?? null;
  }

  static async listTasks(opts: ListTasksOpts = {}): Promise<WorkTaskRecord[]> {
    const conds = ['archived = false'];
    const values: any[] = [];
    let idx = 1;
    WorkItemsModel.pushClosedFilter(conds, opts);
    if (opts.projectId) { conds.push(`project_id = $${ idx++ }`); values.push(opts.projectId); }
    if (opts.epicId)    { conds.push(`epic_id = $${ idx++ }`);    values.push(opts.epicId); }
    if (opts.parentId)  { conds.push(`parent_id = $${ idx++ }`);  values.push(opts.parentId); }
    if (opts.status)    { conds.push(`status = $${ idx++ }`);     values.push(opts.status); }
    if (opts.priority)  { conds.push(`priority = $${ idx++ }`);   values.push(opts.priority); }
    if (opts.assignee)  { conds.push(`assignee = $${ idx++ }`);   values.push(opts.assignee); }
    const limit = opts.limit ?? 50;
    values.push(limit);
    return postgresClient.query<WorkTaskRecord>(
      `SELECT * FROM ${ WorkItemsModel.TASKS }
        WHERE ${ conds.join(' AND ') }
        ORDER BY ${ PRIORITY_RANK }, due_at ASC NULLS LAST, last_moved_at ASC, position ASC
        LIMIT $${ idx }`,
      values,
    );
  }

  // ──────────────────────────────────────────────
  // Comments
  // ──────────────────────────────────────────────

  static async addComment(input: AddCommentInput): Promise<WorkCommentRecord> {
    const task = await WorkItemsModel.getTask(input.task_id);
    if (!task) throw new Error(`No task found with id: ${ input.task_id }`);
    const id = input.id || await WorkItemsModel.uniqueId(WorkItemsModel.COMMENTS);
    const rows = await postgresClient.query<WorkCommentRecord>(
      `INSERT INTO ${ WorkItemsModel.COMMENTS } (id, task_id, body, author)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, input.task_id, input.body, input.author ?? 'agent'],
    );
    return rows[0];
  }

  static async listComments(taskId: string): Promise<WorkCommentRecord[]> {
    return postgresClient.query<WorkCommentRecord>(
      `SELECT * FROM ${ WorkItemsModel.COMMENTS }
        WHERE task_id = $1 AND archived = false
        ORDER BY created_at ASC`,
      [taskId],
    );
  }

  /**
   * Unified reverse-chronological activity feed for the Projects area: comments,
   * newly created tasks/epics/projects, status/board moves, and metadata edits —
   * newest first. Synthesized via UNION over the project tables' timestamp columns
   * (no audit table), so each item yields at most one row per event kind.
   *
   * Bind params: $1 = projectId (or null = all), $2 = author filter (or null),
   * $3 = row limit. The author filter only applies to comments; when set, the
   * lifecycle events (which have no recorded actor) are excluded.
   */
  static async listRecentActivity(opts: ListActivityOpts = {}): Promise<WorkActivityRecord[]> {
    const { PROJECTS, EPICS, TASKS, COMMENTS } = WorkItemsModel;
    const projectId = opts.projectId ?? null;
    const author = opts.author ?? null;
    const limit = Math.min(Math.max(1, opts.limit ?? 80), 200);

    return postgresClient.query<WorkActivityRecord>(
      `WITH activity AS (
        -- comments (and Heartbeat cycle notes)
        SELECT
          c.id          AS id,
          'comment'     AS kind,
          c.created_at  AS activity_at,
          c.body        AS body,
          c.author      AS author,
          t.id          AS task_id,
          t.title       AS task_title,
          t.status      AS task_status,
          t.priority    AS task_priority,
          p.id          AS project_id,
          p.title       AS project_title,
          p.slug        AS project_slug,
          e.id          AS epic_id,
          e.title       AS epic_title
        FROM ${ COMMENTS } c
        JOIN ${ TASKS } t    ON t.id = c.task_id
        JOIN ${ PROJECTS } p ON p.id = t.project_id
        LEFT JOIN ${ EPICS } e ON e.id = t.epic_id AND e.archived = false
        WHERE c.archived = false AND t.archived = false AND p.archived = false
          AND ($1::text IS NULL OR t.project_id = $1)
          AND ($2::text IS NULL OR LOWER(COALESCE(c.author, '')) = LOWER($2))

        UNION ALL
        -- task created
        SELECT 'tc:' || t.id, 'task_created', t.created_at, NULL, NULL,
               t.id, t.title, t.status, t.priority,
               p.id, p.title, p.slug, e.id, e.title
        FROM ${ TASKS } t
        JOIN ${ PROJECTS } p ON p.id = t.project_id
        LEFT JOIN ${ EPICS } e ON e.id = t.epic_id AND e.archived = false
        WHERE t.archived = false AND p.archived = false AND $2::text IS NULL
          AND ($1::text IS NULL OR t.project_id = $1)

        UNION ALL
        -- task status / board move
        SELECT 'tm:' || t.id, 'task_moved', t.last_moved_at, NULL, NULL,
               t.id, t.title, t.status, t.priority,
               p.id, p.title, p.slug, e.id, e.title
        FROM ${ TASKS } t
        JOIN ${ PROJECTS } p ON p.id = t.project_id
        LEFT JOIN ${ EPICS } e ON e.id = t.epic_id AND e.archived = false
        WHERE t.archived = false AND p.archived = false AND $2::text IS NULL
          AND t.last_moved_at IS DISTINCT FROM t.created_at
          AND ($1::text IS NULL OR t.project_id = $1)

        UNION ALL
        -- task metadata edit (distinct from its create and move)
        SELECT 'tu:' || t.id, 'task_updated', t.updated_at, NULL, NULL,
               t.id, t.title, t.status, t.priority,
               p.id, p.title, p.slug, e.id, e.title
        FROM ${ TASKS } t
        JOIN ${ PROJECTS } p ON p.id = t.project_id
        LEFT JOIN ${ EPICS } e ON e.id = t.epic_id AND e.archived = false
        WHERE t.archived = false AND p.archived = false AND $2::text IS NULL
          AND t.updated_at IS NOT NULL
          AND t.updated_at IS DISTINCT FROM t.created_at
          AND t.updated_at IS DISTINCT FROM t.last_moved_at
          AND ($1::text IS NULL OR t.project_id = $1)

        UNION ALL
        -- epic created
        SELECT 'ec:' || e.id, 'epic_created', e.created_at, NULL, NULL,
               NULL, NULL, e.status, e.priority,
               p.id, p.title, p.slug, e.id, e.title
        FROM ${ EPICS } e
        JOIN ${ PROJECTS } p ON p.id = e.project_id
        WHERE e.archived = false AND p.archived = false AND $2::text IS NULL
          AND ($1::text IS NULL OR e.project_id = $1)

        UNION ALL
        -- epic updated / moved
        SELECT 'eu:' || e.id, 'epic_updated', GREATEST(e.updated_at, e.last_moved_at), NULL, NULL,
               NULL, NULL, e.status, e.priority,
               p.id, p.title, p.slug, e.id, e.title
        FROM ${ EPICS } e
        JOIN ${ PROJECTS } p ON p.id = e.project_id
        WHERE e.archived = false AND p.archived = false AND $2::text IS NULL
          AND GREATEST(e.updated_at, e.last_moved_at) IS DISTINCT FROM e.created_at
          AND ($1::text IS NULL OR e.project_id = $1)

        UNION ALL
        -- project created
        SELECT 'pc:' || p.id, 'project_created', p.created_at, NULL, NULL,
               NULL, NULL, p.status, p.priority,
               p.id, p.title, p.slug, NULL, NULL
        FROM ${ PROJECTS } p
        WHERE p.archived = false AND $2::text IS NULL
          AND ($1::text IS NULL OR p.id = $1)

        UNION ALL
        -- project updated / moved
        SELECT 'pu:' || p.id, 'project_updated', GREATEST(p.updated_at, p.last_moved_at), NULL, NULL,
               NULL, NULL, p.status, p.priority,
               p.id, p.title, p.slug, NULL, NULL
        FROM ${ PROJECTS } p
        WHERE p.archived = false AND $2::text IS NULL
          AND GREATEST(p.updated_at, p.last_moved_at) IS DISTINCT FROM p.created_at
          AND ($1::text IS NULL OR p.id = $1)
      )
      SELECT *, activity_at AS created_at
      FROM activity
      WHERE activity_at IS NOT NULL
      ORDER BY activity_at DESC
      LIMIT $3`,
      [projectId, author, limit],
    );
  }

  // ──────────────────────────────────────────────
  // Archive (soft-delete, cascades down)
  // ──────────────────────────────────────────────

  static async archive(kind: WorkItemKind | string, id: string): Promise<boolean> {
    if (kind === 'project') {
      const project = await WorkItemsModel.getProject(id);
      if (!project || project.archived) return false;
      await postgresClient.query(
        `UPDATE ${ WorkItemsModel.COMMENTS } SET archived = true, updated_at = now()
          WHERE task_id IN (SELECT id FROM ${ WorkItemsModel.TASKS } WHERE project_id = $1)`,
        [id],
      );
      await postgresClient.query(
        `UPDATE ${ WorkItemsModel.TASKS } SET archived = true, updated_at = now()
          WHERE project_id = $1`,
        [id],
      );
      await postgresClient.query(
        `UPDATE ${ WorkItemsModel.EPICS } SET archived = true, updated_at = now()
          WHERE project_id = $1`,
        [id],
      );
      await postgresClient.query(
        `UPDATE ${ WorkItemsModel.PROJECTS } SET archived = true, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      return true;
    }

    if (kind === 'epic') {
      const epic = await WorkItemsModel.getEpic(id);
      if (!epic || epic.archived) return false;
      await postgresClient.query(
        `UPDATE ${ WorkItemsModel.COMMENTS } SET archived = true, updated_at = now()
          WHERE task_id IN (SELECT id FROM ${ WorkItemsModel.TASKS } WHERE epic_id = $1)`,
        [id],
      );
      await postgresClient.query(
        `UPDATE ${ WorkItemsModel.TASKS } SET archived = true, updated_at = now()
          WHERE epic_id = $1`,
        [id],
      );
      await postgresClient.query(
        `UPDATE ${ WorkItemsModel.EPICS } SET archived = true, updated_at = now()
          WHERE id = $1`,
        [id],
      );
      return true;
    }

    if (kind === 'task') {
      const task = await WorkItemsModel.getTask(id);
      if (!task || task.archived) return false;
      await postgresClient.query(
        `UPDATE ${ WorkItemsModel.COMMENTS } SET archived = true, updated_at = now()
          WHERE task_id = $1
             OR task_id IN (SELECT id FROM ${ WorkItemsModel.TASKS } WHERE parent_id = $1)`,
        [id],
      );
      await postgresClient.query(
        `UPDATE ${ WorkItemsModel.TASKS } SET archived = true, updated_at = now()
          WHERE id = $1 OR parent_id = $1`,
        [id],
      );
      return true;
    }

    return false;
  }

  // ──────────────────────────────────────────────
  // Search
  // ──────────────────────────────────────────────

  static async search(opts: SearchOpts): Promise<SearchHit[]> {
    const words = tokenizeQuery(opts.query);
    const limit = opts.limit ?? 20;
    const kinds: WorkItemKind[] = opts.kind && ['project', 'epic', 'task'].includes(opts.kind)
      ? [opts.kind as WorkItemKind]
      : ['project', 'epic', 'task'];

    const hits: SearchHit[] = [];
    for (const kind of kinds) {
      const remaining = limit - hits.length;
      if (remaining <= 0) break;
      const table = kind === 'project' ? WorkItemsModel.PROJECTS
        : kind === 'epic' ? WorkItemsModel.EPICS
          : WorkItemsModel.TASKS;
      const conds: string[] = [];
      const values: any[] = [];
      let idx = 1;
      if (!opts.includeArchived) conds.push('archived = false');

      if (words.length === 0) {
        conds.push(`(title ILIKE $${ idx } OR description ILIKE $${ idx })`);
        values.push(`%${ opts.query }%`);
        idx += 1;
      } else {
        const wordConds = words.map((w) => {
          const p = `$${ idx++ }`;
          values.push(`%${ w }%`);
          return `(title ILIKE ${ p } OR description ILIKE ${ p })`;
        });
        conds.push(`(${ wordConds.join(' OR ') })`);
      }

      values.push(remaining);
      const rows = await postgresClient.query<SearchHit>(
        `SELECT '${ kind }' AS kind, id, title, status, priority, archived
           FROM ${ table }
          WHERE ${ conds.join(' AND ') }
          ORDER BY last_moved_at DESC
          LIMIT $${ idx }`,
        values,
      );
      hits.push(...rows);
    }
    return hits.slice(0, limit);
  }
}
