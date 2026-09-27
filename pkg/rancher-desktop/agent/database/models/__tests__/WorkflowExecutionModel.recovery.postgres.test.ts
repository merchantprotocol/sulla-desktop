/** @jest-environment node */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../PostgresClient';
import { up as createWorkflowCheckpoints } from '../../migrations/0017_create_workflow_checkpoints_table';
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

/**
 * Reproduces three production failures of workflow recovery (observed in
 * sulla.log / workflow_executions on 2026-09-22..26):
 *  1. a task-scoped row with an expired lease made nextLeaseExpiry() return a
 *     past time forever → recovery re-armed every second (57k passes/day);
 *  2. resuming a singleton was refused by its own interrupted predecessor →
 *     every auto-restart failed and burned the attempt ceiling (25 runs);
 *  3. a resumed non-singleton left its original row leased-then-expired →
 *     recovery resumed it again (duplicate runs) until the ceiling.
 */
const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;

describeWithPostgres('WorkflowExecutionModel recovery (migrated PostgreSQL)', () => {
  const schema = `wfrecovery_${ randomUUID().replaceAll('-', '') }`;
  let bootstrapPool: Pool;
  let pool: Pool;
  const original = {
    transaction: postgresClient.transaction,
    query:       postgresClient.query,
    queryOne:    postgresClient.queryOne,
    queryAll:    postgresClient.queryAll,
  };

  beforeAll(async() => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    pool = new Pool({ connectionString, max: 4, options: `-c search_path=${ schema }` });
    for (const migration of [
      createWorkflowCheckpoints, createWorkflows, createWorkflowExecutions, createWorkItems,
      createWorkTaskDispatches, addVerificationDispatches,
      createLaneDefinitions, createLaneWorkflowBindings, scopeLaneWorkflowExecutions,
      extendDispatchCustody, addWorkflowExecutionLeases,
    ]) await pool.query(migration as any);
    await pool.query(`INSERT INTO workflows (id, name, status, definition) VALUES
      ('singleton', 'Singleton', 'production', '{}'::jsonb),
      ('plain', 'Plain', 'production', '{}'::jsonb),
      ('lane', 'Lane', 'production', '{}'::jsonb)`);
    await pool.query(`INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'P')`);
    await pool.query(`INSERT INTO work_epics (id, project_id, title) VALUES ('e1', 'p1', 'E')`);
    await pool.query(`INSERT INTO work_tasks (id, project_id, epic_id, title) VALUES ('t1', 'p1', 'e1', 'T')`);

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
    (postgresClient as any).query = async(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
    (postgresClient as any).queryOne = async(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] ?? null;
    (postgresClient as any).queryAll = async(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
  }, 60_000);

  afterAll(async() => {
    Object.assign(postgresClient as any, original);
    await pool?.end();
    await bootstrapPool?.query(`DROP SCHEMA "${ schema }" CASCADE`);
    await bootstrapPool?.end();
  });

  beforeEach(async() => {
    await pool.query('DELETE FROM workflow_executions');
  });

  const row = (id: string) => pool.query('SELECT * FROM workflow_executions WHERE execution_id = $1', [id]).then(r => r.rows[0]);

  it('nextLeaseExpiry ignores task-scoped rows it cannot recover (no 1s re-arm loop)', async() => {
    // The exact production shape: a suspended lane run, scope_task_id set, lease expired days ago.
    await pool.query(`INSERT INTO workflow_executions (execution_id, workflow_id, status, auto_restart, scope_task_id, scope_generation, lease_expires_at, owner_id)
      VALUES ('lane-exec-t1-4', 'lane', 'suspended', TRUE, 't1', 1, NOW() - INTERVAL '4 days', 'runtime-1')`);

    expect(await WorkflowExecutionModel.findStaleExecutions()).toHaveLength(0);
    expect(await WorkflowExecutionModel.nextLeaseExpiry()).toBeNull();
  });

  it('resumes an interrupted singleton instead of refusing it', async() => {
    await pool.query(`INSERT INTO workflow_executions (execution_id, workflow_id, status, auto_restart, lease_expires_at, owner_id)
      VALUES ('orig', 'singleton', 'suspended', TRUE, NOW() - INTERVAL '1 minute', 'runtime-1')`);
    const recovered = await WorkflowExecutionModel.recover('orig');
    expect(recovered).not.toBeNull();

    // Guard still intact: an unrelated admission is refused while it is active.
    await expect(WorkflowExecutionModel.admitSingleton({
      executionId: 'fresh', workflowId: 'singleton', workflowName: 'Singleton', workflowSlug: 'singleton',
    })).rejects.toThrow('already has an active execution');

    await WorkflowExecutionModel.admitSingleton({
      executionId: 'orig-resume-1', workflowId: 'singleton', workflowName: 'Singleton', workflowSlug: 'singleton',
    }, { supersedesExecutionId: 'orig' });

    expect(await row('orig')).toMatchObject({ status: 'failed', terminal_reason: 'resumed', owner_id: null, lease_expires_at: null });
    expect((await row('orig')).error).toContain('orig-resume-1');
    expect(await row('orig-resume-1')).toMatchObject({ status: 'running' });
  });

  it('a resumed run is never recovered (resumed) a second time', async() => {
    await pool.query(`INSERT INTO workflow_executions (execution_id, workflow_id, status, auto_restart, lease_expires_at, owner_id)
      VALUES ('plain-orig', 'plain', 'running', TRUE, NOW() - INTERVAL '1 minute', 'runtime-1')`);
    expect(await WorkflowExecutionModel.recover('plain-orig', 'runtime-2', 1)).not.toBeNull();

    await WorkflowExecutionModel.markRunning({ executionId: 'plain-orig-resume-1', workflowId: 'plain', workflowName: 'Plain', workflowSlug: 'plain' });
    await WorkflowExecutionModel.supersede('plain-orig', 'plain-orig-resume-1');
    await new Promise(resolve => setTimeout(resolve, 20)); // recover()'s 1ms lease is long gone

    const stale = await WorkflowExecutionModel.findStaleExecutions();
    expect(stale.map(e => (e.attributes as any).execution_id)).not.toContain('plain-orig');
    expect(await WorkflowExecutionModel.recover('plain-orig')).toBeNull();
  });

  it('supersede never rewrites a terminal row or the new execution itself', async() => {
    await pool.query(`INSERT INTO workflow_executions (execution_id, workflow_id, status, completed_at)
      VALUES ('done', 'plain', 'completed', NOW())`);
    await WorkflowExecutionModel.supersede('done', 'x');
    await WorkflowExecutionModel.markRunning({ executionId: 'self', workflowId: 'plain', workflowName: 'Plain', workflowSlug: 'plain' });
    await WorkflowExecutionModel.supersede('self', 'self');

    expect(await row('done')).toMatchObject({ status: 'completed' });
    expect(await row('self')).toMatchObject({ status: 'running' });
  });
});
