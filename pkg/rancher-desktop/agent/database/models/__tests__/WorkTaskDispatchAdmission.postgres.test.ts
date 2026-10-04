/** @jest-environment node */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const postgresSuite = connectionString ? describe : describe.skip;

postgresSuite('dispatcher broad admission against PostgreSQL', () => {
  const schema = `admission_${ randomUUID().replaceAll('-', '') }`;
  const original = { query: postgresClient.query, transaction: postgresClient.transaction };
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
        origin_dispatch_id text, origin_agent_id text, origin_evidence jsonb, reviewer_agent_ids text[]
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
      CREATE TABLE work_lane_entry_automations (task_id text, status text, workflow_snapshot jsonb);
      CREATE TABLE work_task_planning_runs (task_id text, status text);
      CREATE TABLE agent_jobs (job_id text, status text, results jsonb);
      INSERT INTO work_projects VALUES ('enabled', 'working', true), ('paused', 'blocked', false);
      INSERT INTO lifecycle_capabilities VALUES
        ('todo-execution', true, 'healthy', 'dispatcher', 'manual_hold', false),
        ('in-review-verification', true, 'healthy', 'dispatcher', 'manual_hold', false);
    `);
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
    await pool.query('TRUNCATE work_tasks, work_task_dispatches, work_task_stage_claims, work_task_waits, work_task_dependencies, work_lane_entry_automations, work_task_planning_runs');
  });

  afterAll(async() => {
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
      INSERT INTO work_lane_entry_automations VALUES ('lane', 'running', '{}')`);
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'a')).resolves.not.toBeNull();
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'b')).resolves.toBeNull();
    await expect(WorkTaskDispatchModel.claimNext('sulla-desktop', 'runtime', undefined, 'lane')).resolves.toBeNull();
    expect(await WorkTaskDispatchModel.enumerateCandidates()).toHaveLength(3);
  });
});
