/** @jest-environment node */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { WorkLaneWorkflowBindingModel } from '../WorkLaneWorkflowBindingModel';
import { WorkTaskPlanningRunModel } from '../WorkTaskPlanningRunModel';
import { WorkLaneDefinitionModel } from '../WorkLaneDefinitionModel';
import { LifecycleCapabilityModel } from '../LifecycleCapabilityModel';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const postgresSuite = connectionString ? describe : describe.skip;

postgresSuite('dispatcher broad admission against PostgreSQL', () => {
  const schema = `admission_${ randomUUID().replaceAll('-', '') }`;
  const original = { query: postgresClient.query, queryOne: postgresClient.queryOne, transaction: postgresClient.transaction };
  let bootstrap: Pool;
  let pool: Pool;

  beforeAll(async() => {
    bootstrap = new Pool({ connectionString });
    await bootstrap.query(`CREATE SCHEMA "${ schema }"`);
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${ schema }` });
    await pool.query(`
      CREATE TABLE work_projects (id text PRIMARY KEY, status text, dispatch_enabled boolean);
      CREATE TABLE work_epics (id text PRIMARY KEY, project_id text, status text);
      CREATE TABLE work_tasks (
        id text PRIMARY KEY, project_id text, epic_id text, status text, archived boolean DEFAULT false,
        assignee text, labels text[], source_ref text, github_issue text,
        last_activity_at timestamptz DEFAULT now(), last_moved_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(), last_moved_by text
      );
      CREATE TABLE work_task_dispatches (
        id text PRIMARY KEY, task_id text, agent_id text, thread_id text, kind text, attempt int,
        status text DEFAULT 'running', started_at timestamptz DEFAULT now(), finished_at timestamptz,
        origin_dispatch_id text, origin_agent_id text, origin_evidence jsonb, reviewer_agent_ids text[],
        artifact_url text, artifact_location text
      );
      CREATE TABLE work_task_stage_claims (
        id text PRIMARY KEY, task_id text, capability_key text, stage text, owner text,
        runtime_instance_id text, status text DEFAULT 'active'
      );
      CREATE TABLE lifecycle_capabilities (
        capability_key text PRIMARY KEY, enabled boolean, health text, active_owner text,
        fallback_mode text, fallback_active boolean
      );
      CREATE TABLE work_task_waits (task_id text, status text);
      CREATE TABLE work_task_dependencies (dependent_task_id text, depends_on_task_id text, archived_at timestamptz);
      CREATE TABLE work_lane_entry_automations (
        id text PRIMARY KEY, task_id text, generation int, previous_lane_key text, lane_key text,
        binding_id text, workflow_id text, resolution_source text, fallback_reason text,
        binding_snapshot jsonb, workflow_snapshot jsonb, status text, actor text,
        execution_id text, started_at timestamptz, UNIQUE(task_id, generation)
      );
      CREATE TABLE work_task_artifact_custody (id text, task_id text, custody jsonb, created_at timestamptz DEFAULT now());
      CREATE TABLE work_lane_definitions (lane_key text, semantic_role text, system_required boolean,
        reset_at timestamptz, archived boolean DEFAULT false, enabled boolean DEFAULT true, scope text, project_id text);
      INSERT INTO work_lane_definitions (lane_key, semantic_role, system_required, scope)
        VALUES ('in_progress', 'execution', true, 'global_default');
      CREATE TABLE work_lane_workflow_bindings (profile_id text, active boolean, archived boolean,
        scope text, epic_id text, lane_key text, project_id text, semantic_role text, created_at timestamptz);
      CREATE TABLE work_project_domain_events (id text, task_id text, generation int, generation_hash text,
        event_type text, idempotency_key text UNIQUE, payload jsonb, occurred_at timestamptz);
      CREATE TABLE work_task_planning_runs (id text PRIMARY KEY, task_id text, status text DEFAULT 'active',
        workflow_id text, trigger_status text, trigger_actor text, attempt int);
      CREATE TABLE agent_jobs (job_id text, status text, results jsonb);
      INSERT INTO work_projects VALUES ('enabled', 'working', true), ('paused', 'blocked', false);
      INSERT INTO lifecycle_capabilities VALUES
        ('todo-execution', true, 'healthy', 'dispatcher', 'manual_hold', false),
        ('in-review-verification', true, 'healthy', 'dispatcher', 'manual_hold', false);
    `);
    (postgresClient as any).queryOne = async(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows[0] ?? null;
    (postgresClient as any).query = async(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows;
    (postgresClient as any).transaction = async(callback: any) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
  });

  beforeEach(async() => {
    jest.spyOn(WorkLaneDefinitionModel, 'runtimeCapability').mockResolvedValue({
      ready: false, catalogPresent: false, missingRoles: ['planning'], degradedReason: 'fixture',
    });
    jest.spyOn(WorkLaneDefinitionModel, 'preferredLaneKey').mockResolvedValue('planning');
    await pool.query('TRUNCATE work_tasks, work_task_dispatches, work_task_stage_claims, work_task_waits, work_task_dependencies, work_lane_entry_automations, work_task_planning_runs, work_task_artifact_custody, work_project_domain_events');
  });

  afterAll(async() => {
    jest.restoreAllMocks();
    Object.assign(postgresClient, original);
    await pool?.end();
    await bootstrap?.query(`DROP SCHEMA "${ schema }" CASCADE`);
    await bootstrap?.end();
  });

  it('enumerates more than 500 epicless tasks, including paused work, in recency order', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status, last_activity_at, last_moved_at, updated_at, created_at)
      SELECT n::text, CASE WHEN n = 601 THEN 'paused' ELSE 'enabled' END, 'custom_lane',
        now() + n * interval '1 second', now(), now(), now() FROM generate_series(1, 601) n`);
    const candidates = await WorkTaskDispatchModel.enumerateCandidates();
    expect(candidates).toHaveLength(601);
    expect(candidates[0]).toMatchObject({ id: '601', project_dispatch_enabled: false, epic_id: null });
    expect(candidates[600].id).toBe('1');
  });

  it('claims waiting human-owned custom-lane work in place and rejects a duplicate claim', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status, assignee, labels)
      VALUES ('custom', 'enabled', 'custom_lane', 'human', ARRAY['gated']), ('dependency', 'paused', 'todo', null, '{}');
      INSERT INTO work_task_waits VALUES ('custom', 'active');
      INSERT INTO work_task_dependencies VALUES ('custom', 'dependency', null)`);
    const claims = await Promise.all([1, 2].map(n => WorkTaskDispatchModel.claimNext('sulla-desktop', `runtime-${ n }`, undefined, 'custom')));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.task.status).toBe('custom_lane');
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM work_task_dispatches WHERE status='running'")).rows[0].count).toBe(1);
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'dependency')).resolves.toBeNull();
  });

  it('enforces three total leases during concurrent mixed review/execution claims', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status) VALUES
      ('a', 'enabled', 'in_review'), ('b', 'enabled', 'custom'), ('c', 'enabled', 'blocked'), ('d', 'enabled', 'in_review')`);
    const claims = await Promise.all([
      WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], 'runtime-a', 'a'),
      WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime-b', undefined, 'b'),
      WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime-c', undefined, 'c'),
      WorkTaskDispatchModel.claimNextReview('sulla-desktop', [], 'runtime-d', 'd'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(3);
  });

  it('holds live lane writers and duplicate PRs without removing them from consideration', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status, github_issue) VALUES
      ('a', 'enabled', 'custom', 'owner/repo#1'), ('b', 'enabled', 'custom', 'owner/repo#1'), ('lane', 'enabled', 'custom', null);
      INSERT INTO work_lane_entry_automations (id, task_id, status, workflow_snapshot) VALUES ('lane-entry', 'lane', 'running', '{}')`);
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'a')).resolves.not.toBeNull();
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'b')).resolves.toBeNull();
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'lane')).resolves.toBeNull();
    expect(await WorkTaskDispatchModel.enumerateCandidates()).toHaveLength(3);
  });
  it('admits unresolved todo dependencies through real lane-entry and audit SQL', async() => {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status) VALUES
      ('todo', 'enabled', 'todo'), ('prerequisite', 'paused', 'todo');
      INSERT INTO work_task_dependencies VALUES ('todo', 'prerequisite', null)`);
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'todo'))
      .resolves.toMatchObject({ task: { status: 'in_progress' } });
    expect((await pool.query("SELECT * FROM work_lane_entry_automations WHERE task_id='todo'")).rows)
      .toHaveLength(1);
    expect((await pool.query("SELECT * FROM work_project_domain_events WHERE task_id='todo'")).rows)
      .toHaveLength(1);
  });

  async function taskWithLane(id: string, reference: string | null = null, owner?: string): Promise<void> {
    await pool.query(`INSERT INTO work_tasks (id, project_id, status, github_issue)
      VALUES ($1, 'enabled', 'planning', $2)`, [id, reference]);
    await pool.query(`INSERT INTO work_lane_entry_automations
      (id, task_id, generation, lane_key, status, workflow_snapshot)
      VALUES ($1, $2, 1, 'planning', 'pending', $3)`,
    [`entry-${ id }`, id, JSON.stringify(owner ? { laneContract: { owner } } : {})]);
  }

  const admit = (kind: string, id: string) => kind === 'lane'
    ? WorkLaneWorkflowBindingModel.markStarted(`entry-${ id }`, `exec-${ id }`)
    : kind === 'planning' ? WorkTaskPlanningRunModel.claim(id, 'planning')
      : WorkTaskDispatchModel.claimNext('sulla-desktop', `runtime-${ id }`, undefined, id);

  it.each([['lane', 'planning'], ['planning', 'lane'], ['lane', 'dispatch'], ['dispatch', 'lane']])(
    'prevents same-task writers in %s then %s order', async(first, second) => {
      await taskWithLane('same');
      await expect(admit(first, 'same')).resolves.not.toBeNull();
      await expect(admit(second, 'same')).resolves.toBeNull();
    });

  it.each([['lane', 'planning'], ['planning', 'lane'], ['lane', 'dispatch'],
    ['dispatch', 'lane'], ['planning', 'dispatch'], ['dispatch', 'planning']])(
    'reserves equivalent PR references across %s and %s', async(first, second) => {
      await taskWithLane('a', 'https://github.com/Owner/Repo/pull/925/files?diff=split');
      await taskWithLane('b', 'owner/repo#925');
      const results = await Promise.all([admit(first, 'a'), admit(second, 'b')]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await WorkTaskDispatchModel.enumerateCandidates()).toHaveLength(2);
    });

  it('reserves custody-only artifact references across mixed writers', async() => {
    await taskWithLane('a');
    await taskWithLane('b', 'owner/repo#925');
    await pool.query(`INSERT INTO work_task_artifact_custody (id, task_id, custody)
      VALUES ('custody-a', 'a', '{"prUrl":"https://github.com/OWNER/REPO/pull/925"}')`);
    await expect(admit('planning', 'a')).resolves.not.toBeNull();
    await expect(admit('lane', 'b')).resolves.toBeNull();
  });

  it('only starts the current lane generation and holds it behind a still-running old generation', async() => {
    await taskWithLane('a');
    await pool.query(`INSERT INTO work_lane_entry_automations
      (id, task_id, generation, lane_key, status, workflow_snapshot)
      VALUES ('new-a', 'a', 2, 'planning', 'pending', '{}')`);
    await expect(admit('lane', 'a')).resolves.toBeNull();
    await pool.query("UPDATE work_lane_entry_automations SET status='running' WHERE id='entry-a'");
    await expect(WorkLaneWorkflowBindingModel.markStarted('new-a', 'new-exec')).resolves.toBeNull();
    await pool.query("UPDATE work_lane_entry_automations SET status='completed' WHERE id='entry-a'");
    await expect(WorkLaneWorkflowBindingModel.markStarted('new-a', 'new-exec')).resolves.not.toBeNull();
  });

  it.each([['planning-council', 'planning'], ['task-dispatcher', 'dispatch']])(
    'allows only the named service to take over a %s delegation marker', async(owner, service) => {
      await taskWithLane('a', null, owner);
      await expect(admit('lane', 'a')).resolves.not.toBeNull();
      await expect(admit(service === 'planning' ? 'dispatch' : 'planning', 'a')).resolves.toBeNull();
      await expect(admit(service, 'a')).resolves.not.toBeNull();
      await expect(admit(service, 'a')).resolves.toBeNull();
    });

  it('bounds simultaneous lane, planning and dispatcher writers to three tasks', async() => {
    for (const id of ['a', 'b', 'c', 'd']) await taskWithLane(id);
    const results = await Promise.all([
      admit('lane', 'a'), admit('planning', 'b'), admit('dispatch', 'c'), admit('lane', 'd'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it('coordinates direct lifecycle leases with lane and dispatcher writers', async() => {
    await taskWithLane('a', 'owner/repo#925');
    await taskWithLane('b', 'https://github.com/owner/repo/pull/925');
    const direct = await LifecycleCapabilityModel.claimStage('a', 'todo-execution', 'planning', 'dispatcher', 'direct');
    expect(direct.claimed).toBe(true);
    await expect(admit('lane', 'a')).resolves.toBeNull();
    await expect(admit('dispatch', 'b')).resolves.toBeNull();
    await expect(LifecycleCapabilityModel.claimStage('a', 'todo-execution', 'planning', 'dispatcher', 'direct'))
      .resolves.toMatchObject({ claimed: true, claim: { id: direct.claim?.id } });
  });

});
