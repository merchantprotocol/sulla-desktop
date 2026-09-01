/** @jest-environment node */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as createWorkflows } from '../../migrations/0023_create_workflows_table';
import { up as createWorkflowExecutions } from '../../migrations/0026_create_workflow_executions_table';
import { up as createWorkItems } from '../../migrations/0044_create_work_items_tables';
import { up as createWorkTaskDispatches } from '../../migrations/0062_create_work_task_dispatches';
import { up as addVerificationDispatches } from '../../migrations/0064_add_verification_dispatches';
import { up as createLaneDefinitions } from '../../migrations/0069_create_work_lane_definitions';
import { up as createLaneWorkflowBindings } from '../../migrations/0070_create_lane_workflow_bindings';
import { up as scopeLaneWorkflowExecutions } from '../../migrations/0071_scope_lane_workflow_executions';
import { up as extendDispatchCustody } from '../../migrations/0076_extend_work_task_dispatch_custody';
import { up as addWorkflowExecutionLeases } from '../../migrations/0081_add_workflow_execution_leases';
import { WorkflowExecutionModel } from '../WorkflowExecutionModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

describeWithPostgres('WorkflowExecutionModel dispatcher reconciliation (migrated PostgreSQL)', () => {
  const schema = `reconcile_${ randomUUID().replaceAll('-', '') }`;
  let bootstrapPool: Pool;
  let pool: Pool;
  const originalTransaction = postgresClient.transaction;

  beforeAll(async() => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${ schema }` });
    for (const migration of [
      createWorkflows, createWorkflowExecutions, createWorkItems,
      createWorkTaskDispatches, addVerificationDispatches,
      createLaneDefinitions, createLaneWorkflowBindings, scopeLaneWorkflowExecutions,
      extendDispatchCustody, addWorkflowExecutionLeases,
    ]) await pool.query(migration as any);
    await pool.query(`INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'Reconcile')`);
    await pool.query(`INSERT INTO work_epics (id, project_id, title) VALUES ('e1', 'p1', 'Reconcile')`);
    await pool.query(`INSERT INTO work_tasks (id, project_id, epic_id, title) VALUES ('t1', 'p1', 'e1', 'Task 1')`);

    (postgresClient as any).transaction = async(callback: (client: any) => Promise<unknown>) => {
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
  }, 30_000);

  afterAll(async() => {
    (postgresClient as any).transaction = originalTransaction;
    await pool?.end();
    await bootstrapPool?.query(`DROP SCHEMA "${ schema }" CASCADE`);
    await bootstrapPool?.end();
  });

  it('leaves a live lane-automation council alone after its originating dispatch settled terminal', async() => {
    // The MjXr repro: the task's mechanical dispatch settled 'blocked', the
    // blocked-lane council then launched as a task-scoped lane execution with
    // its own live lease and no dispatch row referencing it.
    await pool.query(`
      INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, status, finished_at)
      VALUES ('d1', 't1', 'sulla-desktop', 'thread-1', 'blocked', now())`);
    await pool.query(`
      INSERT INTO workflow_executions
        (execution_id, workflow_id, status, scope_task_id, scope_generation, started_at,
         owner_id, lease_token, leased_at, heartbeat_at, lease_expires_at)
      VALUES ('lane-exec-t1-2', 'core-routine-plan-project-task', 'running', 't1', 2, now(),
              'runtime-1', 'token-1', now(), now(), now() + interval '60 seconds')`);
    await pool.query(`
      INSERT INTO work_lane_entry_automations
        (id, task_id, generation, lane_key, resolution_source, status, execution_id, started_at)
      VALUES ('lane-entry-1', 't1', 2, 'blocked', 'core', 'running', 'lane-exec-t1-2', now())`);

    const reconciled = await WorkflowExecutionModel.reconcileDispatcherOwnedExecutions();

    expect(reconciled).toEqual([]);
    const execution = (await pool.query(`
      SELECT status, terminal_reason, lease_token FROM workflow_executions
       WHERE execution_id = 'lane-exec-t1-2'`)).rows[0];
    expect(execution).toMatchObject({ status: 'running', terminal_reason: null, lease_token: 'token-1' });
    const lane = (await pool.query(`
      SELECT status, outcome FROM work_lane_entry_automations WHERE id = 'lane-entry-1'`)).rows[0];
    expect(lane).toMatchObject({ status: 'running', outcome: null });
  });

  it('reaps a dispatch-parented execution once its parent settles, and spares one with a live parent', async() => {
    await pool.query(`
      INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, status, kind, workflow_execution_id, finished_at)
      VALUES ('d2', 't1', 'sulla-desktop', 'thread-2', 'failed', 'verification', 'review-exec-dead', now())`);
    await pool.query(`
      INSERT INTO work_task_dispatches (id, task_id, agent_id, thread_id, status, kind, workflow_execution_id)
      VALUES ('d3', 't1', 'sulla-desktop', 'thread-3', 'running', 'verification', 'review-exec-live')`);
    await pool.query(`
      INSERT INTO workflow_executions (execution_id, workflow_id, status, scope_task_id, scope_generation, started_at)
      VALUES ('review-exec-dead', 'review-project-artifact-a', 'running', 't1', 3, now()),
             ('review-exec-live', 'review-project-artifact-b', 'running', 't1', 4, now())`);

    const reconciled = await WorkflowExecutionModel.reconcileDispatcherOwnedExecutions();

    expect(reconciled).toEqual(['review-exec-dead']);
    const dead = (await pool.query(`
      SELECT status, terminal_reason FROM workflow_executions WHERE execution_id = 'review-exec-dead'`)).rows[0];
    expect(dead).toMatchObject({ status: 'failed', terminal_reason: 'dispatcher_parent_terminal_or_missing' });
    const live = (await pool.query(`
      SELECT status, terminal_reason FROM workflow_executions WHERE execution_id = 'review-exec-live'`)).rows[0];
    expect(live).toMatchObject({ status: 'running', terminal_reason: null });
    // The lane council from the previous scenario is still untouched.
    const lane = (await pool.query(`
      SELECT status FROM work_lane_entry_automations WHERE id = 'lane-entry-1'`)).rows[0];
    expect(lane.status).toBe('running');
  });
});
