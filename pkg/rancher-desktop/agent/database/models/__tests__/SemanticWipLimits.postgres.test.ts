import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';
import { postgresClient } from '../../PostgresClient';
import { up as createWorkflows } from '../../migrations/0023_create_workflows_table';
import { up as createWorkflowExecutions } from '../../migrations/0026_create_workflow_executions_table';
import { up as addCoreWorkflowFields } from '../../migrations/0055_add_system_and_content_hash_to_workflows';
import { up as createWorkItems } from '../../migrations/0044_create_work_items_tables';
import { up as addWorkTaskActor } from '../../migrations/0047_add_work_task_actor';
import { up as addWorkTaskActivity } from '../../migrations/0061_add_work_task_activity';
import { up as createWorkTaskDispatches } from '../../migrations/0062_create_work_task_dispatches';
import { up as addVerificationDispatches } from '../../migrations/0064_add_verification_dispatches';
import { up as createWorkTaskWaits } from '../../migrations/0065_create_work_task_waits';
import { up as addReviewDispositionEvidence } from '../../migrations/0067_add_review_disposition_evidence';
import { up as createLifecycleCapabilities } from '../../migrations/0068_create_lifecycle_capabilities';
import { up as createLaneDefinitions } from '../../migrations/0069_create_work_lane_definitions';
import { up as createLaneWorkflowBindings } from '../../migrations/0070_create_lane_workflow_bindings';
import { up as scopeLaneWorkflowExecutions } from '../../migrations/0071_scope_lane_workflow_executions';
import { up as createWorkTaskPlanningRuns } from '../../migrations/0072_create_work_task_planning_runs';
import { up as addSemanticLaneRuntimeHelpers } from '../../migrations/0074_semantic_lane_runtime_helpers';
import { up as extendDispatchCustody } from '../../migrations/0076_extend_work_task_dispatch_custody';
import { WorkTaskDispatchModel } from '../WorkTaskDispatchModel';
import { evaluateClaim, type WipLimits } from '../../../services/ProjectAutomationWipLimits';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

const unlimited: WipLimits = {
  backlog: null, planning: null, execution: null, review: null,
  blocked: null, terminal: null, manual: null,
};

describeWithPostgres('SemanticWipLimits (issue #711) — migrated Postgres', () => {
  const schema = 'wip_' + randomUUID().replace(/-/g, '');
  let bootstrapPool: Pool | undefined;
  let pool: Pool | undefined;
  let schemaCreated = false;
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;
  const originalQueryAll = postgresClient.queryAll;
  const originalTransaction = postgresClient.transaction;

  beforeAll(async () => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    schemaCreated = true;
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${ schema }` });
    for (const migration of [
      createWorkflows, createWorkflowExecutions, addCoreWorkflowFields, createWorkItems,
      addWorkTaskActor, addWorkTaskActivity, createWorkTaskDispatches, addVerificationDispatches,
      createWorkTaskWaits, addReviewDispositionEvidence, createLifecycleCapabilities,
      createLaneDefinitions, createLaneWorkflowBindings, scopeLaneWorkflowExecutions,
      createWorkTaskPlanningRuns, addSemanticLaneRuntimeHelpers, extendDispatchCustody,
    ]) await pool.query(migration as any);

    (postgresClient as any).query = async (text: string, params: unknown[] = []) =>
      (await pool!.query(text, params)).rows;
    (postgresClient as any).queryOne = async (text: string, params: unknown[] = []) =>
      (await pool!.query(text, params)).rows[0] ?? null;
    (postgresClient as any).queryAll = async (text: string, params: unknown[] = []) =>
      (await pool!.query(text, params)).rows;
    (postgresClient as any).transaction = async (callback: (client: any) => Promise<unknown>) => {
      const client = await pool!.connect();
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

    await pool.query(`
      INSERT INTO work_projects (id, slug, title) VALUES ('wip-proj', 'wip', 'WIP limits');
      INSERT INTO work_epics (id, project_id, title) VALUES ('wip-epic', 'wip-proj', 'Conveyor');
      INSERT INTO work_lane_definitions
        (id, lane_key, scope, project_id, display_name, position, semantic_role, system_required)
      VALUES
        ('g-backlog',  'backlog',     'global_default', NULL, 'Backlog',  0,  'backlog',   true),
        ('g-todo',     'todo',        'global_default', NULL, 'Todo',     10, 'execution', true),
        ('g-progress', 'in_progress', 'global_default', NULL, 'Progress', 20, 'execution', true),
        ('g-planning', 'planning',    'global_default', NULL, 'Planning', 30, 'planning',  true),
        ('g-review',   'in_review',   'global_default', NULL, 'Review',   40, 'review',    true),
        ('g-blocked',  'blocked',     'global_default', NULL, 'Blocked',  50, 'blocked',   true),
        ('g-done',     'done',        'global_default', NULL, 'Done',     60, 'terminal',  true),
        ('p-qagate',   'qa-gate',     'project', 'wip-proj', 'QA gate',   45, 'review',    false);
    `);

    // Autonomous conveyor state: 2 in_review + 1 custom review lane => review role = 3;
    // 2 todo + 1 in_progress => execution role = 3; 1 blocked. A human-gated task is excluded.
    await pool.query(`
      INSERT INTO work_tasks (id, project_id, epic_id, title, status, assignee, labels) VALUES
        ('t-r1', 'wip-proj', 'wip-epic', 'review a',  'in_review',   'heartbeat',  '{}'),
        ('t-r2', 'wip-proj', 'wip-epic', 'review b',  'in_review',   'dispatcher', '{}'),
        ('t-r3', 'wip-proj', 'wip-epic', 'custom qa', 'qa-gate',     'dispatcher', '{}'),
        ('t-e1', 'wip-proj', 'wip-epic', 'todo a',    'todo',        'heartbeat',  '{}'),
        ('t-e2', 'wip-proj', 'wip-epic', 'todo b',    'todo',        NULL,         '{}'),
        ('t-e3', 'wip-proj', 'wip-epic', 'progress',  'in_progress', 'dispatcher', '{}'),
        ('t-b1', 'wip-proj', 'wip-epic', 'blocked',   'blocked',     'heartbeat',  '{}'),
        ('t-x1', 'wip-proj', 'wip-epic', 'gated',     'in_review',   'heartbeat',  ARRAY['gated']);
    `);
  });

  afterAll(async () => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).queryAll = originalQueryAll;
    (postgresClient as any).transaction = originalTransaction;
    await pool?.end();
    if (bootstrapPool && schemaCreated) {
      await bootstrapPool.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`);
    }
    await bootstrapPool?.end();
  });

  it('resolves custom lanes to semantic roles and counts queued+active work (AC2)', async () => {
    const counts = await WorkTaskDispatchModel.countByRole();
    expect(counts.review).toBe(3);     // 2 in_review + 1 custom qa-gate; human-gated excluded
    expect(counts.execution).toBe(3);  // 2 todo + 1 in_progress
    expect(counts.blocked).toBe(1);
  });

  it('holds fresh execution intake while a downstream stage is saturated (AC1)', async () => {
    const counts = await WorkTaskDispatchModel.countByRole();
    const decision = evaluateClaim('execution', counts, { ...unlimited, review: 3 });
    expect(decision.allowed).toBe(false);
    expect(decision.owningRole).toBe('review');
  });

  it('resumes upstream work when the limit is raised (dynamic settings, AC5)', async () => {
    const counts = await WorkTaskDispatchModel.countByRole();
    expect(evaluateClaim('execution', counts, { ...unlimited, review: 5 }).allowed).toBe(true);
  });

  it('returns a consistent snapshot under concurrent reads (AC3 read-consistency)', async () => {
    const [a, b] = await Promise.all([
      WorkTaskDispatchModel.countByRole(),
      WorkTaskDispatchModel.countByRole(),
    ]);
    expect(a).toEqual(b);
  });
});
