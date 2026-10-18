import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

import type { ProjectsConfig } from './config.js';

const PROJECT_TABLES = [
  'work_projects', 'work_epics', 'work_tasks', 'work_task_comments', 'work_lane_definitions',
  'work_project_views', 'work_task_dependencies', 'work_project_pipeline_templates',
  'work_project_pipeline_template_stages', 'work_item_knowledge_links', 'work_task_claims',
  'work_project_domain_events', 'projects_knowledge_projection', 'work_schedule_audit', 'work_task_artifact_custody',
  'work_artifact_receipts', 'github_pr_project_mirrors',
] as const;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS projects_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS projects_import_ledger(source_fingerprint text PRIMARY KEY, tenant_id text NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(), row_counts jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS projects_tenant_registry(tenant_id text PRIMARY KEY, last_seen_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS work_projects(
 tenant_id text NOT NULL, id text NOT NULL, slug text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '', outcome_metric text,
 status text NOT NULL DEFAULT 'working', priority text NOT NULL DEFAULT 'p2', owner text, due_at timestamptz, source text, source_path text,
 source_ref text, github_repo text, assigned_agent text, dispatch_enabled boolean NOT NULL DEFAULT false, pipeline_template_id text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz, last_moved_at timestamptz NOT NULL DEFAULT now(), archived boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,slug));
CREATE TABLE IF NOT EXISTS work_epics(
 tenant_id text NOT NULL, id text NOT NULL, project_id text NOT NULL, slug text, title text NOT NULL, description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'working', priority text NOT NULL DEFAULT 'p2', position integer NOT NULL DEFAULT 0, due_at timestamptz,
 start_at timestamptz, milestone_at timestamptz, source text, source_ref text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz,
 last_moved_at timestamptz NOT NULL DEFAULT now(), archived boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES work_projects(tenant_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS work_epics_tenant_slug ON work_epics(tenant_id,project_id,slug) WHERE slug IS NOT NULL AND archived=false;
CREATE TABLE IF NOT EXISTS work_tasks(
 tenant_id text NOT NULL, id text NOT NULL, project_id text NOT NULL, epic_id text, parent_id text, slug text, title text NOT NULL,
 description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'todo', priority text NOT NULL DEFAULT 'p2', assignee text, due_at timestamptz,
 start_at timestamptz, milestone_at timestamptz, labels text[] NOT NULL DEFAULT '{}', github_issue text, position integer NOT NULL DEFAULT 0,
 source text, source_ref text, created_by text, last_moved_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz,
 last_moved_at timestamptz NOT NULL DEFAULT now(), last_activity_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 archived boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,project_id) REFERENCES work_projects(tenant_id,id),
 FOREIGN KEY(tenant_id,epic_id) REFERENCES work_epics(tenant_id,id),
 FOREIGN KEY(tenant_id,parent_id) REFERENCES work_tasks(tenant_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE UNIQUE INDEX IF NOT EXISTS work_tasks_tenant_slug ON work_tasks(tenant_id,epic_id,slug) WHERE slug IS NOT NULL AND archived=false;
CREATE INDEX IF NOT EXISTS work_tasks_board ON work_tasks(tenant_id,project_id,archived,status,priority,due_at);
CREATE TABLE IF NOT EXISTS work_task_comments(
 tenant_id text NOT NULL, id text NOT NULL, task_id text NOT NULL, body text NOT NULL, author text, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz, archived boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,task_id) REFERENCES work_tasks(tenant_id,id));
CREATE TABLE IF NOT EXISTS work_lane_definitions(
 tenant_id text NOT NULL, id text NOT NULL, lane_key text NOT NULL, scope text NOT NULL CHECK(scope IN ('global_default','project')), project_id text,
 base_lane_key text, display_name text NOT NULL, description text NOT NULL DEFAULT '', color text, icon text, position integer NOT NULL DEFAULT 0,
 semantic_role text NOT NULL, enabled boolean NOT NULL DEFAULT true, archived boolean NOT NULL DEFAULT false, system_required boolean NOT NULL DEFAULT false,
 requires_human_approval boolean NOT NULL DEFAULT false, created_by text, updated_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz,
 archived_at timestamptz, reset_at timestamptz, PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,project_id) REFERENCES work_projects(tenant_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS work_lanes_tenant_key ON work_lane_definitions(tenant_id,scope,coalesce(project_id,''),lane_key) WHERE reset_at IS NULL;
CREATE TABLE IF NOT EXISTS work_project_views(
 tenant_id text NOT NULL, id text NOT NULL, project_id text, name text NOT NULL DEFAULT 'Default', view_type text NOT NULL,
 configuration jsonb NOT NULL DEFAULT '{}', is_default boolean NOT NULL DEFAULT false, created_by text NOT NULL DEFAULT 'human',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,project_id) REFERENCES work_projects(tenant_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS work_views_tenant_default ON work_project_views(tenant_id,coalesce(project_id,''),is_default) WHERE is_default=true AND archived=false;
CREATE TABLE IF NOT EXISTS work_task_dependencies(
 tenant_id text NOT NULL, id text NOT NULL, dependent_task_id text NOT NULL, depends_on_task_id text NOT NULL, relation_type text NOT NULL DEFAULT 'requires',
 acceptance_condition text, created_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,dependent_task_id) REFERENCES work_tasks(tenant_id,id),
 FOREIGN KEY(tenant_id,depends_on_task_id) REFERENCES work_tasks(tenant_id,id), CHECK(dependent_task_id<>depends_on_task_id));
CREATE UNIQUE INDEX IF NOT EXISTS work_deps_tenant_unique ON work_task_dependencies(tenant_id,dependent_task_id,depends_on_task_id,relation_type) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS work_project_pipeline_templates(
 tenant_id text NOT NULL, id text NOT NULL, template_key text NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 system boolean NOT NULL DEFAULT false, locked boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true, created_by text, updated_by text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz, archived_at timestamptz, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,template_key));
CREATE TABLE IF NOT EXISTS work_project_pipeline_template_stages(
 tenant_id text NOT NULL, id text NOT NULL, template_id text NOT NULL, stage_key text NOT NULL, display_name text NOT NULL, description text NOT NULL DEFAULT '',
 position integer NOT NULL, semantic_role text, bundled_workflow_id text, entry_policy jsonb NOT NULL DEFAULT '{}', wip_limit integer,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz, PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,template_id) REFERENCES work_project_pipeline_templates(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,template_id,stage_key), UNIQUE(tenant_id,template_id,position));
ALTER TABLE work_projects DROP CONSTRAINT IF EXISTS work_projects_pipeline_template_fk;
ALTER TABLE work_projects ADD CONSTRAINT work_projects_pipeline_template_fk
 FOREIGN KEY(tenant_id,pipeline_template_id) REFERENCES work_project_pipeline_templates(tenant_id,id)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE IF NOT EXISTS projects_knowledge_projection(
 tenant_id text NOT NULL, id text NOT NULL, node_type text NOT NULL DEFAULT 'entity', title text NOT NULL, summary text NOT NULL DEFAULT '', detail text,
 archived boolean NOT NULL DEFAULT false, merged_into text, source text, link_count integer NOT NULL DEFAULT 0, recall_count integer NOT NULL DEFAULT 0,
 last_recalled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || summary)) STORED, PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,merged_into) REFERENCES projects_knowledge_projection(tenant_id,id) DEFERRABLE INITIALLY DEFERRED);
CREATE INDEX IF NOT EXISTS projects_knowledge_projection_search ON projects_knowledge_projection USING gin(search_tsv);
CREATE TABLE IF NOT EXISTS work_item_knowledge_links(
 tenant_id text NOT NULL, id text NOT NULL, knowledge_node_id text NOT NULL, project_id text, epic_id text, task_id text, relation_type text NOT NULL DEFAULT 'related_to',
 note text, source text, created_by text, updated_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 archived boolean NOT NULL DEFAULT false, PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,knowledge_node_id) REFERENCES projects_knowledge_projection(tenant_id,id),
 FOREIGN KEY(tenant_id,project_id) REFERENCES work_projects(tenant_id,id), FOREIGN KEY(tenant_id,epic_id) REFERENCES work_epics(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES work_tasks(tenant_id,id), CHECK(num_nonnulls(project_id,epic_id,task_id)=1));
CREATE UNIQUE INDEX IF NOT EXISTS work_links_project_unique ON work_item_knowledge_links(tenant_id,knowledge_node_id,project_id,relation_type) WHERE project_id IS NOT NULL AND archived=false;
CREATE UNIQUE INDEX IF NOT EXISTS work_links_epic_unique ON work_item_knowledge_links(tenant_id,knowledge_node_id,epic_id,relation_type) WHERE epic_id IS NOT NULL AND archived=false;
CREATE UNIQUE INDEX IF NOT EXISTS work_links_task_unique ON work_item_knowledge_links(tenant_id,knowledge_node_id,task_id,relation_type) WHERE task_id IS NOT NULL AND archived=false;
CREATE TABLE IF NOT EXISTS work_task_claims(
 tenant_id text NOT NULL, id uuid NOT NULL, task_id text NOT NULL, owner_subject text NOT NULL, external_ref text NOT NULL, lease_hash text NOT NULL,
 prior_assignee text, claimed_assignee text NOT NULL, expires_at timestamptz NOT NULL, released_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz, PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,task_id) REFERENCES work_tasks(tenant_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS work_claims_live ON work_task_claims(tenant_id,task_id) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS work_project_domain_events(
 tenant_id text NOT NULL, id text NOT NULL, task_id text NOT NULL, generation integer NOT NULL DEFAULT 0, generation_hash text, event_type text NOT NULL,
 idempotency_key text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), lease_owner text, leased_until timestamptz, last_error text, occurred_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz, completed_at timestamptz, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,task_id) REFERENCES work_tasks(tenant_id,id));
CREATE INDEX IF NOT EXISTS work_domain_events_pending ON work_project_domain_events(tenant_id,available_at,occurred_at)
 WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS work_domain_events_expired ON work_project_domain_events(tenant_id,leased_until)
 WHERE status='processing';
CREATE TABLE IF NOT EXISTS work_schedule_audit(
 tenant_id text NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY, item_kind text NOT NULL, item_id text NOT NULL, field_name text NOT NULL,
 old_value timestamptz, new_value timestamptz, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id));
CREATE TABLE IF NOT EXISTS work_task_artifact_custody(
 tenant_id text NOT NULL, id text NOT NULL, task_id text NOT NULL, transition text NOT NULL, work_kind text NOT NULL, custody jsonb NOT NULL,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES work_tasks(tenant_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS work_artifact_receipts(
 tenant_id text NOT NULL, id text NOT NULL, receipt_version integer NOT NULL DEFAULT 1, task_id text NOT NULL, event_type text NOT NULL, actor text,
 workflow_execution_id text, dispatch_id text, disposition text, next_owner text, validation_summary text, artifacts jsonb NOT NULL DEFAULT '[]',
 content_hashes text[] NOT NULL DEFAULT '{}', evidence_kind text, evidence_ref text, evidence_url text, fingerprint text NOT NULL, comment_id text,
 generation integer, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,task_id) REFERENCES work_tasks(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,comment_id) REFERENCES work_task_comments(tenant_id,id) ON DELETE SET NULL, UNIQUE(tenant_id,task_id,fingerprint));
CREATE TABLE IF NOT EXISTS github_pr_project_mirrors(
 tenant_id text NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY, provider text NOT NULL DEFAULT 'github', owner text NOT NULL, repository text NOT NULL,
 pull_number integer NOT NULL, task_id text, project_id text NOT NULL, epic_id text NOT NULL, parent_id text, snapshot_fingerprint text,
 remote_updated_at timestamptz, last_seen_at timestamptz NOT NULL DEFAULT now(), sync_generation integer NOT NULL DEFAULT 0,
 remote_disposition text NOT NULL DEFAULT 'unknown', last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz,
 archived_at timestamptz, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,provider,owner,repository,pull_number),
 FOREIGN KEY(tenant_id,task_id) REFERENCES work_tasks(tenant_id,id), FOREIGN KEY(tenant_id,project_id) REFERENCES work_projects(tenant_id,id),
 FOREIGN KEY(tenant_id,epic_id) REFERENCES work_epics(tenant_id,id), FOREIGN KEY(tenant_id,parent_id) REFERENCES work_tasks(tenant_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS github_pr_mirror_task_unique ON github_pr_project_mirrors(tenant_id,task_id) WHERE task_id IS NOT NULL AND archived_at IS NULL;
`;

const quoteIdent = (value: string) => `"${ value.replace(/"/g, '""') }"`;

async function applyRls(client: PoolClient, runtimeRole: string): Promise<void> {
  for (const table of PROJECT_TABLES) {
    const name = quoteIdent(table);
    await client.query(`ALTER TABLE ${ name } ALTER COLUMN tenant_id SET DEFAULT current_setting('app.current_tenant', true)`);
    await client.query(`ALTER TABLE ${ name } ENABLE ROW LEVEL SECURITY; ALTER TABLE ${ name } FORCE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY IF EXISTS projects_tenant_isolation ON ${ name }`);
    await client.query(`CREATE POLICY projects_tenant_isolation ON ${ name }
      USING (tenant_id = current_setting('app.current_tenant', true))
      WITH CHECK (tenant_id = current_setting('app.current_tenant', true))`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${ name } TO ${ quoteIdent(runtimeRole) }`);
  }
  await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ quoteIdent(runtimeRole) }`);
}

export async function migrateProjectsDatabase(config: ProjectsConfig): Promise<void> {
  const pool = new Pool({ connectionString: config.migrationDatabaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('sulla-projects-schema-migration'))");
    await client.query('BEGIN');
    await client.query(SCHEMA_V1);
    await client.query('INSERT INTO projects_schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING');
    await applyRls(client, config.runtimeRole);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON projects_tenant_registry TO ${ quoteIdent(config.runtimeRole) }`);
    await client.query(`INSERT INTO projects_tenant_registry(tenant_id) VALUES($1)
      ON CONFLICT(tenant_id) DO UPDATE SET last_seen_at=now()`, [config.tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('sulla-projects-schema-migration'))").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

const LEGACY_TABLES: Array<{ source: string; target: string }> = [
  { source: 'work_project_pipeline_templates', target: 'work_project_pipeline_templates' },
  { source: 'work_project_pipeline_template_stages', target: 'work_project_pipeline_template_stages' },
  { source: 'work_projects', target: 'work_projects' }, { source: 'work_epics', target: 'work_epics' },
  { source: 'work_tasks', target: 'work_tasks' }, { source: 'work_task_comments', target: 'work_task_comments' },
  { source: 'work_lane_definitions', target: 'work_lane_definitions' }, { source: 'work_project_views', target: 'work_project_views' },
  { source: 'work_task_dependencies', target: 'work_task_dependencies' },
  // Projects owns only a tenant-scoped projection of knowledge_nodes. Every
  // non-generated node column is copied, but Knowledge keeps ownership of
  // node_aliases and node_links; those tables are intentionally neither
  // imported nor fenced here.
  { source: 'knowledge_nodes', target: 'projects_knowledge_projection' },
  { source: 'work_item_knowledge_links', target: 'work_item_knowledge_links' },
  { source: 'work_project_domain_events', target: 'work_project_domain_events' },
  { source: 'work_schedule_audit', target: 'work_schedule_audit' },
  { source: 'work_task_artifact_custody', target: 'work_task_artifact_custody' },
  { source: 'work_artifact_receipts', target: 'work_artifact_receipts' },
  { source: 'github_pr_project_mirrors', target: 'github_pr_project_mirrors' },
];
const LEGACY_FENCED_TABLES = new Set(LEGACY_TABLES.map(mapping => mapping.source).filter(table => table !== 'knowledge_nodes'));
const LEGACY_FENCE_TRIGGER = 'sulla_projects_container_write_fence';
const LEGACY_FENCE_FUNCTION = 'sulla_projects_reject_legacy_write';

async function installLegacyWriteFence(client: PoolClient, tables: string[]): Promise<void> {
  if (!tables.length) return;
  await client.query(`CREATE OR REPLACE FUNCTION ${ quoteIdent(LEGACY_FENCE_FUNCTION) }() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Projects data moved to sulla-projects; legacy write rejected for %', TG_TABLE_NAME
        USING ERRCODE = '55000';
    END $$`);
  for (const table of tables.filter(name => LEGACY_FENCED_TABLES.has(name))) {
    await client.query(`DROP TRIGGER IF EXISTS ${ quoteIdent(LEGACY_FENCE_TRIGGER) } ON ${ quoteIdent(table) }`);
    await client.query(`CREATE TRIGGER ${ quoteIdent(LEGACY_FENCE_TRIGGER) }
      BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${ quoteIdent(table) }
      FOR EACH STATEMENT EXECUTE FUNCTION ${ quoteIdent(LEGACY_FENCE_FUNCTION) }()`);
  }
}

/** Explicit rollback path if the isolated service is retired and legacy ownership must be restored. */
export async function removeLegacyProjectsWriteFence(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of LEGACY_FENCED_TABLES) {
      const exists = await client.query('SELECT to_regclass($1) AS table', [`public.${ table }`]);
      if (exists.rows[0]?.table) {
        await client.query(`DROP TRIGGER IF EXISTS ${ quoteIdent(LEGACY_FENCE_TRIGGER) } ON ${ quoteIdent(table) }`);
      }
    }
    await client.query(`DROP FUNCTION IF EXISTS ${ quoteIdent(LEGACY_FENCE_FUNCTION) }()`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function sourceFingerprint(connectionString: string, tenantId: string): string {
  const url = new URL(connectionString);
  return createHash('sha256').update(`${ url.protocol }//${ url.hostname }:${ url.port }${ url.pathname }#${ tenantId }`).digest('hex');
}

interface TableColumn {
  name: string;
  generated: boolean;
  identity: boolean;
  json: boolean;
}

async function columns(client: PoolClient, table: string): Promise<TableColumn[]> {
  const rows = await client.query<{ column_name: string; is_generated: string; is_identity: string; data_type: string }>(
    `SELECT column_name,is_generated,is_identity,data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  return rows.rows.map(row => ({
    name: row.column_name,
    generated: row.is_generated !== 'NEVER',
    identity: row.is_identity === 'YES',
    json: row.data_type === 'json' || row.data_type === 'jsonb',
  }));
}

function assertCompatibleColumns(mapping: { source: string; target: string }, source: TableColumn[], target: TableColumn[]): TableColumn[] {
  const sourceCopyable = source.filter(column => !column.generated);
  const targetCopyable = target.filter(column => !column.generated && column.name !== 'tenant_id');
  const sourceNames = new Set(sourceCopyable.map(column => column.name));
  const targetNames = new Set(targetCopyable.map(column => column.name));
  const missingSource = targetCopyable.filter(column => !sourceNames.has(column.name)).map(column => column.name);
  const unmappedSource = sourceCopyable.filter(column => !targetNames.has(column.name)).map(column => column.name);
  const sourceGenerated = source.filter(column => column.generated).map(column => column.name).sort();
  const targetGenerated = target.filter(column => column.generated).map(column => column.name).sort();
  if (missingSource.length || unmappedSource.length || JSON.stringify(sourceGenerated) !== JSON.stringify(targetGenerated)) {
    const details = [
      missingSource.length ? `missing in source: ${ missingSource.join(', ') }` : undefined,
      unmappedSource.length ? `unmapped source columns: ${ unmappedSource.join(', ') }` : undefined,
      JSON.stringify(sourceGenerated) !== JSON.stringify(targetGenerated)
        ? `generated columns differ (source: ${ sourceGenerated.join(', ') || 'none' }; target: ${ targetGenerated.join(', ') || 'none' })`
        : undefined,
    ].filter(Boolean).join('; ');
    throw new Error(`Legacy Projects table ${ mapping.source } is incompatible with ${ mapping.target }: ${ details }`);
  }
  return targetCopyable;
}

async function advanceIdentitySequences(client: PoolClient, table: string, identityColumns: TableColumn[]): Promise<void> {
  for (const column of identityColumns) {
    const relation = `public.${ table }`;
    const sequence = await client.query<{ sequence_name: string | null }>(
      'SELECT pg_get_serial_sequence($1,$2) AS sequence_name', [relation, column.name]);
    if (!sequence.rows[0]?.sequence_name) {
      throw new Error(`Projects import could not resolve identity sequence for ${ table }.${ column.name }`);
    }
    await client.query(`SELECT setval(pg_get_serial_sequence($1,$2),
      GREATEST(nextval(pg_get_serial_sequence($1,$2)), (SELECT MAX(${ quoteIdent(column.name) }) FROM ${ quoteIdent(table) })), true)`,
    [relation, column.name]);
  }
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  return value;
}

function contentDigest(rows: Array<Record<string, unknown>>, names: string[]): string {
  const normalized = rows.map(row => names.map(name => canonical(row[name])));
  normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** One-time, idempotent copy from the quiesced Desktop store into the isolated database. */
export async function importLegacyProjects(config: ProjectsConfig): Promise<void> {
  if (!config.legacyDatabaseUrl) return;
  const fingerprint = sourceFingerprint(config.legacyDatabaseUrl, config.tenantId);
  const destination = new Pool({ connectionString: config.migrationDatabaseUrl, max: 1 });
  const source = new Pool({ connectionString: config.legacyDatabaseUrl, max: 1 });
  const sourceClient = await source.connect();
  const destinationClient = await destination.connect();
  const counts: Record<string, number> = Object.create(null);
  try {
    await sourceClient.query('BEGIN');
    const existingSources: string[] = [];
    for (const mapping of LEGACY_TABLES) {
      const exists = await sourceClient.query('SELECT to_regclass($1) AS table', [`public.${ mapping.source }`]);
      if (exists.rows[0]?.table) existingSources.push(mapping.source);
    }
    if (existingSources.length) await sourceClient.query(`LOCK TABLE ${ existingSources.map(quoteIdent).join(',') } IN SHARE MODE`);
    await installLegacyWriteFence(sourceClient, existingSources);
    // Commit the persistent source fence before copying. If the process dies
    // after this point, legacy clients remain rejected and restart is safe.
    await sourceClient.query('COMMIT');
    await sourceClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    if (existingSources.includes('knowledge_nodes')) {
      await sourceClient.query(`LOCK TABLE ${ quoteIdent('knowledge_nodes') } IN SHARE MODE`);
    }
    await destinationClient.query('BEGIN');
    await destinationClient.query("SELECT pg_advisory_xact_lock(hashtext('sulla-projects-legacy-import'))");
    const completed = await destinationClient.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM projects_import_ledger WHERE source_fingerprint=$1 FOR UPDATE', [fingerprint]);
    if (completed.rows[0]) {
      if (completed.rows[0].tenant_id !== config.tenantId) {
        throw new Error('Legacy Projects import ledger tenant does not match the configured tenant');
      }
      // The ledger records a fully verified, transactionally committed import.
      // Destination rows are authoritative after cutover and may legitimately
      // diverge from the now-fenced legacy snapshot, so never re-verify or copy.
      await destinationClient.query('COMMIT');
      await sourceClient.query('COMMIT');
      return;
    }
    for (const mapping of LEGACY_TABLES) {
      if (!existingSources.includes(mapping.source)) continue;
      const sourceColumns = await columns(sourceClient, mapping.source);
      const targetColumns = await columns(destinationClient, mapping.target);
      const copyable = assertCompatibleColumns(mapping, sourceColumns, targetColumns);
      const shared = copyable.map(column => column.name);
      if (!shared.length) continue;
      const rows = await sourceClient.query(`SELECT ${ shared.map(quoteIdent).join(',') } FROM ${ quoteIdent(mapping.source) }`);
      counts[mapping.target] = rows.rowCount ?? 0;
      for (const row of rows.rows as Array<Record<string, unknown>>) {
        const names = ['tenant_id', ...shared];
        const values = [config.tenantId, ...copyable.map(column =>
          column.json && row[column.name] !== null ? JSON.stringify(row[column.name]) : row[column.name])];
        const overriding = copyable.some(column => column.identity) ? ' OVERRIDING SYSTEM VALUE' : '';
        await destinationClient.query(`INSERT INTO ${ quoteIdent(mapping.target) } (${ names.map(quoteIdent).join(',') })${ overriding }
          VALUES (${ values.map((_, index) => `$${ index + 1 }`).join(',') })`, values);
      }
      if (rows.rowCount) await advanceIdentitySequences(destinationClient, mapping.target, copyable.filter(column => column.identity));
      const copied = await destinationClient.query(`SELECT ${ shared.map(quoteIdent).join(',') } FROM ${ quoteIdent(mapping.target) } WHERE tenant_id=$1`, [config.tenantId]);
      if (copied.rowCount !== rows.rowCount || contentDigest(rows.rows, shared) !== contentDigest(copied.rows, shared)) {
        throw new Error(`Legacy Projects verification failed for ${ mapping.source }`);
      }
    }
    await destinationClient.query('INSERT INTO projects_import_ledger(source_fingerprint,tenant_id,row_counts) VALUES($1,$2,$3::jsonb)',
      [fingerprint, config.tenantId, JSON.stringify(counts)]);
    await destinationClient.query('COMMIT');
    await sourceClient.query('COMMIT');
  } catch (error) {
    await destinationClient.query('ROLLBACK').catch(() => undefined);
    await sourceClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    sourceClient.release(); destinationClient.release();
    await source.end(); await destination.end();
  }
}
