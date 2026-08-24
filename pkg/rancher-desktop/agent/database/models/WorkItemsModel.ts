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
import { normalizeAutonomousTaskOwnership } from './TaskOwnership';
import { WorkLaneDefinitionModel, type WorkLaneSemanticRole } from './WorkLaneDefinitionModel';
import { ArtifactCustodyPolicy, type ArtifactCustody } from '../../services/ArtifactCustodyPolicy';

import type { PoolClient } from 'pg';

// ── Types ──────────────────────────────────────────────────────────────

export type WorkItemKind = 'project' | 'epic' | 'task';

export interface WorkProjectRecord {
  id:             string;
  slug:           string;
  title:          string;
  description:    string;
  outcome_metric: string | null;
  status:         string;
  priority:       string;
  owner:          string | null;
  source:         string | null;
  source_path:    string | null;
  github_repo:    string | null;
  due_at:         string | null;
  created_at:     string;
  updated_at:     string | null;
  last_moved_at:  string;
  archived:       boolean;
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
  start_at:      string | null;
  milestone_at:  string | null;
  source:        string | null;
  source_ref:    string | null;
  created_at:    string;
  updated_at:    string | null;
  last_moved_at: string;
  archived:      boolean;
}

export interface WorkTaskRecord {
  id:               string;
  project_id:       string;
  epic_id:          string | null;
  parent_id:        string | null;
  slug:             string | null;
  title:            string;
  description:      string;
  status:           string;
  priority:         string;
  due_at:           string | null;
  start_at:         string | null;
  milestone_at:     string | null;
  github_issue:     string | null;
  assignee:         string | null;
  labels:           string[] | null;
  position:         number;
  source:           string | null;
  source_ref:       string | null;
  created_at:       string;
  updated_at:       string | null;
  last_moved_at:    string;
  last_activity_at: string;
  created_by:       string | null;
  last_moved_by:    string | null;
  completed_at:     string | null;
  archived:         boolean;
}

export interface WorkTaskDependencyRecord {
  task_id:            string;
  depends_on_task_id: string;
  created_at:         string;
  created_by:         string;
  archived:           boolean;
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
  author:        string | null;        // comment author or lifecycle actor
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
  id?:             string;
  slug?:           string;
  title:           string;
  description?:    string;
  outcome_metric?: string | null;
  status?:         string;
  priority?:       string;
  owner?:          string | null;
  due_at?:         string | null;
  source?:         string | null;
  source_ref?:     string | null;
  source_path?:    string | null;
  github_repo?:    string | null;
}

export interface UpdateProjectInput {
  slug?:           string;
  title?:          string;
  description?:    string;
  outcome_metric?: string | null;
  status?:         string;
  priority?:       string;
  owner?:          string | null;
  due_at?:         string | null;
  source?:         string | null;
  source_path?:    string | null;
  github_repo?:    string | null;
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
  start_at?:     string | null;
  milestone_at?: string | null;
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
  start_at?:     string | null;
  milestone_at?: string | null;
  actor?:        string;
  source?:       string | null;
  source_ref?:   string | null;
}

export interface UpsertTaskInput {
  id?:           string;
  project_id?:   string;
  epic_id?:      string | null;
  parent_id?:    string | null;
  slug?:         string;
  title:         string;
  description?:  string;
  status?:       string;
  priority?:     string;
  assignee?:     string | null;
  due_at?:       string | null;
  start_at?:     string | null;
  milestone_at?: string | null;
  labels?:       string[];
  github_issue?: string | null;
  position?:     number;
  source?:       string | null;
  source_ref?:   string | null;
  actor?:        string;
}

export interface UpdateTaskInput {
  epic_id?:      string | null;
  parent_id?:    string | null;
  slug?:         string | null;
  title?:        string;
  description?:  string;
  status?:       string;
  priority?:     string;
  assignee?:     string | null;
  due_at?:       string | null;
  start_at?:     string | null;
  milestone_at?: string | null;
  labels?:       string[];
  github_issue?: string | null;
  position?:     number;
  source?:       string | null;
  source_ref?:   string | null;
  actor?:        string;
  custody?:      ArtifactCustody | null;
}

export interface AddCommentInput {
  id?:     string;
  task_id: string;
  body:    string;
  author?: string;
  actor?:  string;
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
  projectId?:            string;
  epicId?:               string;
  parentId?:             string;
  assignee?:             string;
  semanticRoles?:        WorkLaneSemanticRole[];
  excludeSemanticRoles?: WorkLaneSemanticRole[];
  fallbackStatuses?:     string[];
}

export interface SearchOpts {
  query:            string;
  kind?:            WorkItemKind | string;
  includeArchived?: boolean;
  limit?:           number;
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

// Bare CASE expression, no trailing ASC — reused standalone (with ASC appended
// for ORDER BY) and nested inside EPIC_PRIORITY_RANK_FOR_TASK's COALESCE, where
// an embedded ASC would land inside the parens and break the SQL.
const PRIORITY_CASE = `
  CASE priority
    WHEN '🔴' THEN 0 WHEN 'critical' THEN 0 WHEN 'p0' THEN 0 WHEN 'P0' THEN 0
    WHEN 'p1' THEN 1 WHEN 'P1' THEN 1 WHEN 'high' THEN 1
    WHEN '🟡' THEN 2 WHEN 'p2' THEN 2 WHEN 'P2' THEN 2 WHEN 'medium' THEN 2
    WHEN 'p3' THEN 3 WHEN 'P3' THEN 3
    WHEN '⚪' THEN 4 WHEN 'low' THEN 4 WHEN 'p4' THEN 4 WHEN 'P4' THEN 4
    ELSE 5
  END`;

const PRIORITY_RANK = `${ PRIORITY_CASE } ASC`;

// Same rank scale as PRIORITY_RANK, but resolved for the parent epic via a
// correlated subquery so a task's *epic* priority is available to ORDER BY
// without joining work_epics into the main query (which would make the
// bare `status`/`priority` columns shared with pushClosedFilter's WHERE
// clause ambiguous). Tasks with no epic (or whose epic priority is unset)
// fall back to the task's own rank, so they sort by their own priority
// exactly as before rather than being pushed to the bottom.
const EPIC_PRIORITY_RANK_FOR_TASK = `
  COALESCE(
    (SELECT CASE we.priority
      WHEN '🔴' THEN 0 WHEN 'critical' THEN 0 WHEN 'p0' THEN 0 WHEN 'P0' THEN 0
      WHEN 'p1' THEN 1 WHEN 'P1' THEN 1 WHEN 'high' THEN 1
      WHEN '🟡' THEN 2 WHEN 'p2' THEN 2 WHEN 'P2' THEN 2 WHEN 'medium' THEN 2
      WHEN 'p3' THEN 3 WHEN 'P3' THEN 3
      WHEN '⚪' THEN 4 WHEN 'low' THEN 4 WHEN 'p4' THEN 4 WHEN 'P4' THEN 4
      ELSE 5
    END
    FROM work_epics we WHERE we.id = work_tasks.epic_id),
    ${ PRIORITY_CASE.replace('priority', 'work_tasks.priority') }
  ) ASC`;

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

const FALLBACK_ROLE_KEYS: Record<WorkLaneSemanticRole, string[]> = {
  backlog:   ['backlog'],
  planning:  ['planning'],
  execution: ['todo', 'in_progress'],
  review:    ['in_review'],
  blocked:   ['blocked'],
  terminal:  ['done', 'cancelled'],
  manual:    ['parked'],
};

function fallbackKeys(roles: WorkLaneSemanticRole[]): string[] {
  return Array.from(new Set(roles.flatMap(role => FALLBACK_ROLE_KEYS[role])));
}

/**
 * Bridge committed Projects status writes into the sole matching routine.
 * Dynamic import keeps the Projects model free of main-process/workflow cycles.
 * The task write is already durable when this runs, so bridge failures do not
 * misreport the Projects mutation to its caller.
 */
async function notifyTaskStatusCommitted(
  task: WorkTaskRecord,
  previousStatus: string,
  actor?: string,
): Promise<void> {
  try {
    const capability = await WorkLaneDefinitionModel.runtimeCapability(task.project_id);
    const currentRole = capability.ready
      ? (await WorkLaneDefinitionModel.resolveStatus(task.project_id, task.status))?.semantic_role ?? 'manual'
      : (FALLBACK_ROLE_KEYS.planning.includes(task.status)
        ? 'planning'
        : FALLBACK_ROLE_KEYS.blocked.includes(task.status)
          ? 'blocked'
          : FALLBACK_ROLE_KEYS.execution.includes(task.status) ? 'execution' : 'manual');
    const previousRole = capability.ready
      ? (await WorkLaneDefinitionModel.resolveStatus(task.project_id, previousStatus))?.semantic_role ?? 'manual'
      : (FALLBACK_ROLE_KEYS.planning.includes(previousStatus)
        ? 'planning'
        : FALLBACK_ROLE_KEYS.blocked.includes(previousStatus)
          ? 'blocked'
          : FALLBACK_ROLE_KEYS.execution.includes(previousStatus) ? 'execution' : 'manual');
    if ([currentRole, previousRole].some(role => role === 'blocked' || role === 'planning')) {
      const { PlanningCouncilService } = await import('../../services/PlanningCouncilService');
      await PlanningCouncilService.handleTaskStatusTransition(task, previousStatus, actor);
    }
    if (currentRole === 'execution' && previousRole !== 'execution') {
      const { getTaskDispatcherService } = await import('../../services/TaskDispatcherService');
      await getTaskDispatcherService().forceCheck();
    }
  } catch (err) {
    console.error(`[WorkItemsModel] Post-commit status bridge failed for task ${ task.id }:`, err);
  }
}

// ── Model ──────────────────────────────────────────────────────────────

export class WorkItemsModel {
  private static readonly PROJECTS = 'work_projects';
  private static readonly EPICS = 'work_epics';
  private static readonly TASKS = 'work_tasks';
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
          last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by      TEXT,
          last_moved_by   TEXT,
          completed_at    TIMESTAMPTZ,
          archived        BOOLEAN     NOT NULL DEFAULT false
        )
      `);
      await postgresClient.query(`
        ALTER TABLE ${ WorkItemsModel.TASKS }
          ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ
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
      await postgresClient.query(`
        UPDATE ${ WorkItemsModel.TASKS } t
           SET last_activity_at = GREATEST(
             t.last_moved_at,
             COALESCE(t.updated_at, t.last_moved_at),
             COALESCE((
               SELECT MAX(c.created_at)
                 FROM ${ WorkItemsModel.COMMENTS } c
                WHERE c.task_id = t.id AND c.archived = false
             ), t.last_moved_at)
           )
         WHERE t.last_activity_at IS NULL
      `);
      await postgresClient.query(`
        ALTER TABLE ${ WorkItemsModel.TASKS }
          ALTER COLUMN last_activity_at SET DEFAULT now(),
          ALTER COLUMN last_activity_at SET NOT NULL
      `);
      await postgresClient.query(`
        CREATE INDEX IF NOT EXISTS idx_work_tasks_activity
          ON ${ WorkItemsModel.TASKS } (archived, status, priority, last_activity_at ASC)
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

  private static async auditScheduleChangesWithClient(
    client: Pick<PoolClient, 'query'>,
    kind: 'epic' | 'task', id: string,
    before: Pick<WorkEpicRecord, 'start_at' | 'due_at' | 'milestone_at'>,
    after: Pick<WorkEpicRecord, 'start_at' | 'due_at' | 'milestone_at'>,
    actor = 'sulla',
  ): Promise<void> {
    for (const field of ['start_at', 'due_at', 'milestone_at'] as const) {
      if ((before[field] ?? null) === (after[field] ?? null)) continue;
      await client.query(`INSERT INTO work_schedule_audit
        (item_kind, item_id, field_name, old_value, new_value, actor)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [kind, id, field, before[field] ?? null, after[field] ?? null, actor]);
    }
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

    if (changes.slug !== undefined) assign('slug', changes.slug);
    if (changes.title !== undefined) assign('title', changes.title);
    if (changes.description !== undefined) assign('description', changes.description);
    if (changes.outcome_metric !== undefined) assign('outcome_metric', changes.outcome_metric);
    if (changes.status !== undefined) { assign('status', changes.status); moved = true }
    if (changes.priority !== undefined) { assign('priority', changes.priority); moved = true }
    if (changes.owner !== undefined) assign('owner', changes.owner);
    if (changes.due_at !== undefined) { assign('due_at', changes.due_at); moved = true }
    if (changes.source !== undefined) assign('source', changes.source);
    if (changes.source_path !== undefined) assign('source_path', changes.source_path);
    if (changes.github_repo !== undefined) assign('github_repo', changes.github_repo);

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
    if (opts.status) { conds.push(`status = $${ idx++ }`); values.push(opts.status) }
    if (opts.priority) { conds.push(`priority = $${ idx++ }`); values.push(opts.priority) }
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
          title:        input.title,
          description:  input.description,
          status:       input.status,
          priority:     input.priority,
          position:     input.position,
          due_at:       input.due_at,
          start_at:     input.start_at,
          milestone_at: input.milestone_at,
          source:       input.source,
          source_ref:   input.source_ref,
        })) ?? existing[0];
      }
    }

    const id = input.id || await WorkItemsModel.uniqueId(WorkItemsModel.EPICS);
    const rows = await postgresClient.query<WorkEpicRecord>(
      `INSERT INTO ${ WorkItemsModel.EPICS }
         (id, project_id, slug, title, description, status, priority,
          position, due_at, start_at, milestone_at, source, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        input.start_at ?? null,
        input.milestone_at ?? null,
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

    if (changes.project_id !== undefined) { assign('project_id', changes.project_id); moved = true }
    if (changes.slug !== undefined) assign('slug', changes.slug);
    if (changes.title !== undefined) assign('title', changes.title);
    if (changes.description !== undefined) assign('description', changes.description);
    if (changes.status !== undefined) { assign('status', changes.status); moved = true }
    if (changes.priority !== undefined) { assign('priority', changes.priority); moved = true }
    if (changes.position !== undefined) assign('position', changes.position);
    if (changes.due_at !== undefined) { assign('due_at', changes.due_at); moved = true }
    if (changes.start_at !== undefined) { assign('start_at', changes.start_at); moved = true }
    if (changes.milestone_at !== undefined) { assign('milestone_at', changes.milestone_at); moved = true }
    if (changes.source !== undefined) assign('source', changes.source);
    if (changes.source_ref !== undefined) assign('source_ref', changes.source_ref);

    if (moved) setClauses.push('last_moved_at = now()');
    if (setClauses.length === 1) return existing;

    values.push(id);
    const updateSql = `UPDATE ${ WorkItemsModel.EPICS } SET ${ setClauses.join(', ') }
      WHERE id = $${ idx } RETURNING *`;
    const changesSchedule = changes.due_at !== undefined || changes.start_at !== undefined || changes.milestone_at !== undefined;
    if (!changesSchedule) {
      const rows = await postgresClient.query<WorkEpicRecord>(updateSql, values);
      return rows[0] ?? null;
    }

    return postgresClient.transaction(async(client) => {
      const current = await client.query<WorkEpicRecord>(
        `SELECT * FROM ${ WorkItemsModel.EPICS } WHERE id = $1 AND archived = false FOR UPDATE`, [id]);
      if (!current.rows[0]) return null;
      const rows = await client.query<WorkEpicRecord>(updateSql, values);
      const updated = rows.rows[0] ?? null;
      if (updated) {
        await WorkItemsModel.auditScheduleChangesWithClient(
          client, 'epic', id, current.rows[0], updated, changes.actor);
      }
      return updated;
    });
  }

  static async listEpics(opts: ListEpicsOpts = {}): Promise<WorkEpicRecord[]> {
    const conds = ['archived = false'];
    const values: any[] = [];
    let idx = 1;
    WorkItemsModel.pushClosedFilter(conds, opts);
    if (opts.projectId) { conds.push(`project_id = $${ idx++ }`); values.push(opts.projectId) }
    if (opts.status) { conds.push(`status = $${ idx++ }`); values.push(opts.status) }
    if (opts.priority) { conds.push(`priority = $${ idx++ }`); values.push(opts.priority) }
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

  static async listTaskDependencies(projectId: string): Promise<WorkTaskDependencyRecord[]> {
    return postgresClient.query<WorkTaskDependencyRecord>(`
      SELECT dependency.*
      FROM work_task_dependencies dependency
      JOIN ${ WorkItemsModel.TASKS } task ON task.id = dependency.task_id
      JOIN ${ WorkItemsModel.TASKS } prerequisite ON prerequisite.id = dependency.depends_on_task_id
      WHERE dependency.archived = false
        AND task.archived = false AND prerequisite.archived = false
        AND task.project_id = $1 AND prerequisite.project_id = $1
      ORDER BY dependency.created_at ASC`, [projectId]);
  }

  static async setTaskDependency(taskId: string, dependsOnTaskId: string, actor = 'human'): Promise<WorkTaskDependencyRecord> {
    if (taskId === dependsOnTaskId) throw new Error('A task cannot depend on itself.');
    return postgresClient.transaction(async(client) => {
      const tasks = await client.query<WorkTaskRecord>(`
        SELECT * FROM ${ WorkItemsModel.TASKS }
        WHERE id = ANY($1::text[]) AND archived = false
        FOR UPDATE`, [[taskId, dependsOnTaskId]]);
      if (tasks.rows.length !== 2) throw new Error('Both dependency tasks must be active.');
      if (new Set(tasks.rows.map(task => task.project_id)).size !== 1) {
        throw new Error('Task dependencies must stay within one project.');
      }
      const cycle = await client.query<{ found: boolean }>(`
        WITH RECURSIVE prerequisites(id) AS (
          SELECT $2::text
          UNION
          SELECT dependency.depends_on_task_id
          FROM work_task_dependencies dependency
          JOIN prerequisites current ON dependency.task_id = current.id
          WHERE dependency.archived = false
        )
        SELECT EXISTS(SELECT 1 FROM prerequisites WHERE id = $1) AS found`, [taskId, dependsOnTaskId]);
      if (cycle.rows[0]?.found) throw new Error('This dependency would create a cycle.');
      const rows = await client.query<WorkTaskDependencyRecord>(`
        INSERT INTO work_task_dependencies (task_id, depends_on_task_id, created_by, archived)
        VALUES ($1, $2, $3, false)
        ON CONFLICT (task_id, depends_on_task_id) DO UPDATE
          SET archived = false, created_by = EXCLUDED.created_by, created_at = now()
        RETURNING *`, [taskId, dependsOnTaskId, actor]);
      return rows.rows[0];
    });
  }

  static async removeTaskDependency(taskId: string, dependsOnTaskId: string): Promise<boolean> {
    const rows = await postgresClient.query<{ task_id: string }>(`
      UPDATE work_task_dependencies SET archived = true
      WHERE task_id = $1 AND depends_on_task_id = $2 AND archived = false
      RETURNING task_id`, [taskId, dependsOnTaskId]);
    return rows.length > 0;
  }

  static async insertTask(input: UpsertTaskInput): Promise<WorkTaskRecord> {
    if (!input.epic_id) throw new Error('epic_id is required to create a task.');
    const epic = await WorkItemsModel.requireEpic(input.epic_id);
    const projectId = input.project_id || epic.project_id;
    const slug = input.slug ? input.slug.slice(0, 80) : null;
    const status = input.status ?? 'todo';
    const lane = await WorkLaneDefinitionModel.validateTaskStatus(projectId, status);
    const executionEntryLaneKey = lane?.semantic_role === 'execution'
      ? await WorkLaneDefinitionModel.preferredLaneKey(projectId, 'execution', 'todo', 'first')
      : null;
    const id = input.id || await WorkItemsModel.uniqueId(WorkItemsModel.TASKS);
    const actor = input.actor ?? 'sulla';
    const labels = input.labels ?? [];
    const assignee = normalizeAutonomousTaskOwnership({
      status,
      assignee:              input.assignee ?? null,
      labels,
      actor,
      semanticRole:         lane?.semantic_role,
      executionEntryLaneKey,
    });

    const rows = await postgresClient.query<WorkTaskRecord>(
      `INSERT INTO ${ WorkItemsModel.TASKS }
         (id, project_id, epic_id, parent_id, slug, title, description, status,
          priority, due_at, github_issue, assignee, labels, position, source,
          source_ref, created_by, completed_at, start_at, milestone_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
        assignee,
        labels,
        input.position ?? 0,
        input.source ?? null,
        input.source_ref ?? null,
        actor,
        (lane ? lane.semantic_role === 'terminal' : isClosedStatus(status)) ? new Date().toISOString() : null,
        input.start_at ?? null,
        input.milestone_at ?? null,
      ],
    );
    const created = rows[0];
    if (created) {
      await notifyTaskStatusCommitted(created, '', input.actor);
    }
    return created;
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
          start_at:     input.start_at,
          milestone_at: input.milestone_at,
          labels:       input.labels,
          github_issue: input.github_issue,
          position:     input.position,
          source:       input.source,
          source_ref:   input.source_ref,
          actor:        input.actor,
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
    const targetLane = changes.status !== undefined
      ? await WorkLaneDefinitionModel.validateTaskStatus(nextProjectId ?? existing.project_id, changes.status)
      : null;
    const enteringReview = changes.status !== undefined
      && changes.status !== existing.status
      && (targetLane?.semantic_role === 'review' || (!targetLane && changes.status === 'in_review'));
    const enteringDone = changes.status !== undefined
      && changes.status !== existing.status
      && changes.status === 'done';
    if (enteringReview) {
      await ArtifactCustodyPolicy.assertForTransition('in_review', changes.custody);
    }
    if (enteringDone) {
      await ArtifactCustodyPolicy.assertForTransition('done', changes.custody);
    }
    const ownershipProjectId = nextProjectId ?? existing.project_id;
    const ownershipCapability = changes.status === undefined
      ? await WorkLaneDefinitionModel.runtimeCapability(ownershipProjectId)
      : null;
    const ownershipLane = targetLane ?? (ownershipCapability?.ready
      ? await WorkLaneDefinitionModel.resolveStatus(ownershipProjectId, existing.status)
      : null);
    const ownershipSemanticRole = targetLane?.semantic_role ?? (ownershipCapability?.ready
      ? ownershipLane?.semantic_role ?? 'manual'
      : undefined);
    const executionEntryLaneKey = ownershipLane?.semantic_role === 'execution'
      ? await WorkLaneDefinitionModel.preferredLaneKey(ownershipProjectId, 'execution', 'todo', 'first')
      : null;

    const setClauses: string[] = ['updated_at = now()'];
    const values: any[] = [];
    let idx = 1;
    let moved = false;
    const actor = changes.actor ?? 'sulla';
    const assignee = normalizeAutonomousTaskOwnership({
      status:                changes.status ?? existing.status,
      assignee:              changes.assignee !== undefined ? changes.assignee : existing.assignee,
      labels:                changes.labels ?? existing.labels,
      actor,
      semanticRole:         ownershipSemanticRole,
      executionEntryLaneKey,
    });

    const assign = (col: string, val: any) => {
      setClauses.push(`${ col } = $${ idx++ }`);
      values.push(val);
    };

    if (changes.epic_id !== undefined) { assign('epic_id', changes.epic_id); moved = true }
    if (nextProjectId !== undefined) assign('project_id', nextProjectId);
    if (changes.parent_id !== undefined) { assign('parent_id', changes.parent_id); moved = true }
    if (changes.slug !== undefined) assign('slug', changes.slug);
    if (changes.title !== undefined) assign('title', changes.title);
    if (changes.description !== undefined) assign('description', changes.description);
    if (changes.status !== undefined) { assign('status', changes.status); moved = true }
    if (changes.priority !== undefined) { assign('priority', changes.priority); moved = true }
    if (changes.assignee !== undefined || assignee !== existing.assignee) {
      assign('assignee', assignee);
      moved = true;
    }
    if (changes.due_at !== undefined) { assign('due_at', changes.due_at); moved = true }
    if (changes.start_at !== undefined) { assign('start_at', changes.start_at); moved = true }
    if (changes.milestone_at !== undefined) { assign('milestone_at', changes.milestone_at); moved = true }
    if (changes.labels !== undefined) assign('labels', changes.labels);
    if (changes.github_issue !== undefined) assign('github_issue', changes.github_issue);
    if (changes.position !== undefined) assign('position', changes.position);
    if (changes.source !== undefined) assign('source', changes.source);
    if (changes.source_ref !== undefined) assign('source_ref', changes.source_ref);

    if (changes.status !== undefined) {
      const terminal = targetLane
        ? targetLane.semantic_role === 'terminal'
        : isClosedStatus(changes.status);
      assign('completed_at', terminal ? new Date().toISOString() : null);
    }

    if (moved) {
      setClauses.push('last_moved_at = now()');
      assign('last_moved_by', actor);
    }
    if (setClauses.length === 1) return existing;
    setClauses.push('last_activity_at = now()');

    values.push(id);
    let laneEntryId: string | null = null;
    const updateSql = `UPDATE ${ WorkItemsModel.TASKS } SET ${ setClauses.join(', ') }
      WHERE id = $${ idx } RETURNING *`;
    let updated: WorkTaskRecord | null;

    const changesSchedule = changes.due_at !== undefined || changes.start_at !== undefined || changes.milestone_at !== undefined;
    if (changes.status !== undefined || changesSchedule) {
      updated = await postgresClient.transaction(async(client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lane-entry:${ id }`]);
        const current = await client.query<WorkTaskRecord>(
          `SELECT * FROM ${ WorkItemsModel.TASKS } WHERE id = $1 AND archived = false FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const rows = await client.query<WorkTaskRecord>(updateSql, values);
        const committed = rows.rows[0] ?? null;
        if (committed && enteringReview && changes.custody) {
          await ArtifactCustodyPolicy.persistWithClient(
            client, committed.id, 'in_review', changes.custody, actor);
        }
        if (committed && enteringDone && changes.custody) {
          await ArtifactCustodyPolicy.persistWithClient(
            client, committed.id, 'done', changes.custody, actor);
        }
        if (committed && committed.status !== current.rows[0].status) {
          const { WorkLaneWorkflowBindingModel } = await import('./WorkLaneWorkflowBindingModel');
          const claimed = await WorkLaneWorkflowBindingModel.claimLaneEntryInTransaction(
            client, committed.id, committed.status, changes.actor ?? 'sulla');
          if (claimed.created && claimed.entry.status === 'pending') laneEntryId = claimed.entry.id;
        }
        if (committed && changesSchedule) {
          await WorkItemsModel.auditScheduleChangesWithClient(
            client, 'task', id, current.rows[0], committed, actor);
        }
        return committed;
      });
    } else {
      const rows = await postgresClient.query<WorkTaskRecord>(updateSql, values);
      updated = rows[0] ?? null;
    }

    if (laneEntryId) {
      try {
        const { LaneEntryAutomationService } = await import('../../services/LaneEntryAutomationService');
        await LaneEntryAutomationService.dispatchEntry(laneEntryId);
      } catch (error) {
        console.warn(`[WorkItems] Lane entry ${ laneEntryId } remains recoverable after dispatch failure:`, error);
      }
    }
    if (updated && changes.status !== undefined) {
      await notifyTaskStatusCommitted(updated, existing.status, changes.actor);
    }
    return updated;
  }

  static async listTasks(opts: ListTasksOpts = {}): Promise<WorkTaskRecord[]> {
    const conds = ['archived = false'];
    const values: any[] = [];
    let idx = 1;
    const needsSemanticCatalog = !opts.includeDone || Boolean(opts.semanticRoles?.length) || Boolean(opts.excludeSemanticRoles?.length);
    const capability = needsSemanticCatalog
      ? await WorkLaneDefinitionModel.runtimeCapability(opts.projectId)
      : null;
    const effectiveRole = `(SELECT effective.semantic_role FROM work_lane_definitions effective
      WHERE effective.reset_at IS NULL AND effective.archived = false AND effective.enabled = true
        AND effective.lane_key = work_tasks.status
        AND (effective.scope = 'global_default'
          OR (effective.scope = 'project' AND effective.project_id = work_tasks.project_id))
      ORDER BY CASE WHEN effective.scope = 'project' THEN 0 ELSE 1 END LIMIT 1)`;
    if (!opts.includeDone) {
      if (capability?.ready) {
        conds.push(`COALESCE(${ effectiveRole }, 'manual') <> 'terminal'`);
      } else {
        conds.push(`NOT (${ CLOSED_STATUSES })`);
      }
    }
    if (opts.semanticRoles?.length) {
      const keys = opts.fallbackStatuses?.length ? opts.fallbackStatuses : fallbackKeys(opts.semanticRoles);
      values.push(capability?.ready ? opts.semanticRoles : keys);
      conds.push(capability?.ready
        ? `COALESCE(${ effectiveRole }, 'manual') = ANY($${ idx++ }::text[])`
        : `status = ANY($${ idx++ }::text[])`);
    }
    if (opts.excludeSemanticRoles?.length) {
      const keys = opts.fallbackStatuses?.length ? opts.fallbackStatuses : fallbackKeys(opts.excludeSemanticRoles);
      values.push(capability?.ready ? opts.excludeSemanticRoles : keys);
      conds.push(capability?.ready
        ? `NOT (COALESCE(${ effectiveRole }, 'manual') = ANY($${ idx++ }::text[]))`
        : `NOT (status = ANY($${ idx++ }::text[]))`);
    }
    if (opts.projectId) { conds.push(`project_id = $${ idx++ }`); values.push(opts.projectId) }
    if (opts.epicId) { conds.push(`epic_id = $${ idx++ }`); values.push(opts.epicId) }
    if (opts.parentId) { conds.push(`parent_id = $${ idx++ }`); values.push(opts.parentId) }
    if (opts.status) { conds.push(`status = $${ idx++ }`); values.push(opts.status) }
    if (opts.priority) { conds.push(`priority = $${ idx++ }`); values.push(opts.priority) }
    if (opts.assignee) { conds.push(`assignee = $${ idx++ }`); values.push(opts.assignee) }
    const limit = opts.limit ?? 50;
    values.push(limit);
    return postgresClient.query<WorkTaskRecord>(
      `SELECT * FROM ${ WorkItemsModel.TASKS }
        WHERE ${ conds.join(' AND ') }
        ORDER BY ${ EPIC_PRIORITY_RANK_FOR_TASK }, ${ PRIORITY_RANK }, last_activity_at ASC, due_at ASC NULLS LAST, position ASC
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
      `WITH inserted AS (
         INSERT INTO ${ WorkItemsModel.COMMENTS } (id, task_id, body, author)
         VALUES ($1, $2, $3, $4)
         RETURNING *
       ), touched AS (
         UPDATE ${ WorkItemsModel.TASKS }
            SET last_activity_at = now()
          WHERE id = $2
          RETURNING id
       )
       SELECT inserted.* FROM inserted JOIN touched ON true`,
      [id, input.task_id, input.body, input.author ?? input.actor ?? 'sulla'],
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
   * Latest (non-archived) comment timestamp per task, for the given task ids, in
   * a single grouped query. Used by lane-health staleness: add_task_comment does
   * NOT bump the task's last_moved_at, so a task actively progressed via comments
   * would otherwise read as "no movement" and false-flag as stale every cycle.
   * Returns a Map keyed by task id; tasks with no comments are simply absent.
   */
  static async latestCommentAtByTask(taskIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!taskIds.length) return out;
    const rows = await postgresClient.query<{ task_id: string; latest_comment_at: string }>(
      `SELECT task_id, MAX(created_at) AS latest_comment_at
         FROM ${ WorkItemsModel.COMMENTS }
        WHERE archived = false AND task_id = ANY($1)
        GROUP BY task_id`,
      [taskIds],
    );
    for (const row of rows) {
      if (row.latest_comment_at) out.set(row.task_id, row.latest_comment_at);
    }
    return out;
  }

  /**
   * Unified reverse-chronological activity feed for the Projects area: comments,
   * newly created tasks/epics/projects, status/board moves, and metadata edits —
   * newest first. Synthesized via UNION over the project tables' timestamp columns
   * (no audit table), so each item yields at most one row per event kind.
   *
   * Bind params: $1 = projectId (or null = all), $2 = author/actor filter (or null),
   * $3 = row limit. The author filter applies to the unified author/actor field.
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
          COALESCE(c.author, 'sulla') AS author,
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
        SELECT 'tc:' || t.id, 'task_created', t.created_at, NULL, COALESCE(t.created_by, 'sulla'),
               t.id, t.title, t.status, t.priority,
               p.id, p.title, p.slug, e.id, e.title
        FROM ${ TASKS } t
        JOIN ${ PROJECTS } p ON p.id = t.project_id
        LEFT JOIN ${ EPICS } e ON e.id = t.epic_id AND e.archived = false
        WHERE t.archived = false AND p.archived = false
          AND ($2::text IS NULL OR LOWER(COALESCE(t.created_by, 'sulla')) = LOWER($2))
          AND ($1::text IS NULL OR t.project_id = $1)

        UNION ALL
        -- task status / board move
        SELECT 'tm:' || t.id, 'task_moved', t.last_moved_at, NULL, COALESCE(t.last_moved_by, 'sulla'),
               t.id, t.title, t.status, t.priority,
               p.id, p.title, p.slug, e.id, e.title
        FROM ${ TASKS } t
        JOIN ${ PROJECTS } p ON p.id = t.project_id
        LEFT JOIN ${ EPICS } e ON e.id = t.epic_id AND e.archived = false
        WHERE t.archived = false AND p.archived = false
          AND ($2::text IS NULL OR LOWER(COALESCE(t.last_moved_by, 'sulla')) = LOWER($2))
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
      const table = kind === 'project'
        ? WorkItemsModel.PROJECTS
        : kind === 'epic'
          ? WorkItemsModel.EPICS
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
