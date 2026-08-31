/** @jest-environment node */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool } from 'pg';

import { postgresClient } from '../../database/PostgresClient';
import { up as createSettings } from '../../database/migrations/0011_create_settings_table';
import { up as castSettings } from '../../database/migrations/0012_add_cast_column_to_sulla_settings';
import { up as createWorkflows } from '../../database/migrations/0023_create_workflows_table';
import { up as createWorkflowExecutions } from '../../database/migrations/0026_create_workflow_executions_table';
import { up as createWorkItems } from '../../database/migrations/0044_create_work_items_tables';
import { up as addWorkTaskActor } from '../../database/migrations/0047_add_work_task_actor';
import { up as addCoreWorkflowFields } from '../../database/migrations/0055_add_system_and_content_hash_to_workflows';
import { up as addWorkTaskActivity } from '../../database/migrations/0061_add_work_task_activity';
import { up as createWorkTaskDispatches } from '../../database/migrations/0062_create_work_task_dispatches';
import { up as addVerificationDispatches } from '../../database/migrations/0064_add_verification_dispatches';
import { up as createLifecycleCapabilities } from '../../database/migrations/0068_create_lifecycle_capabilities';
import { up as extendDispatchCustody } from '../../database/migrations/0076_extend_work_task_dispatch_custody';
import { up as createArtifactCustody } from '../../database/migrations/0079_create_work_task_artifact_custody';
import { up as addWorkflowExecutionLeases } from '../../database/migrations/0081_add_workflow_execution_leases';
import { up as createArtifactReceipts } from '../../database/migrations/0082_create_artifact_receipts';
import { up as createOutcomeJournal } from '../../database/migrations/0090_create_work_task_outcome_journal';
import { up as createDispatcherLiveness } from '../../database/migrations/0091_create_dispatcher_liveness';
import { DispatcherLivenessModel } from '../../database/models/DispatcherLivenessModel';
import { WorkTaskDispatchModel } from '../../database/models/WorkTaskDispatchModel';

const connectionString = process.env.SULLA_INTEGRATION_POSTGRES_URL;
const describeWithPostgres = connectionString ? describe : describe.skip;
const seams = [
  'claim-commit-before-graph',
  'worker-return-before-journal',
  'journal-before-finalize',
  'finalize-before-liveness',
  'recover-stale-mid-batch',
] as const;

describeWithPostgres('TaskDispatcher crash/restart convergence soak', () => {
  const schema = `dispatcher_soak_${ randomUUID().replaceAll('-', '') }`;
  let bootstrapPool: Pool;
  let pool: Pool;
  const originalQuery = postgresClient.query;
  const originalQueryOne = postgresClient.queryOne;
  const originalQueryAll = postgresClient.queryAll;
  const originalTransaction = postgresClient.transaction;

  beforeAll(async() => {
    bootstrapPool = new Pool({ connectionString, max: 1 });
    await bootstrapPool.query(`CREATE SCHEMA "${ schema }"`);
    pool = new Pool({ connectionString, max: 8, options: `-c search_path=${ schema }` });
    for (const migration of [
      createSettings, castSettings, createWorkflows, createWorkflowExecutions,
      addCoreWorkflowFields, createWorkItems, addWorkTaskActor, addWorkTaskActivity,
      createWorkTaskDispatches, addVerificationDispatches, createLifecycleCapabilities,
      extendDispatchCustody, createArtifactCustody, addWorkflowExecutionLeases,
      createArtifactReceipts, createOutcomeJournal, createDispatcherLiveness,
    ]) await pool.query(migration as any);
    await pool.query(`CREATE TABLE fault_soak_external_prs (task_id TEXT NOT NULL, url TEXT NOT NULL)`);
    await pool.query(`INSERT INTO work_projects (id, slug, title) VALUES ('p1', 'p1', 'Crash soak')`);
    await pool.query(`INSERT INTO work_epics (id, project_id, title) VALUES ('e1', 'p1', 'Dispatcher')`);
    await pool.query(`
      INSERT INTO lifecycle_capabilities
        (capability_key, version, enabled, health, active_owner, runtime_instance_id, fallback_mode, fallback_active)
      VALUES ('todo-execution', 1, true, 'healthy', 'dispatcher', 'boot-runtime', 'heartbeat', false)
      ON CONFLICT (capability_key) DO UPDATE SET enabled = true, health = 'healthy', active_owner = 'dispatcher'
    `);
    await pool.query(`
      INSERT INTO sulla_settings (property, value, "cast")
      VALUES ('taskDispatcherTruthReconciliationEnabled', 'true', 'boolean')
      ON CONFLICT (property) DO UPDATE SET value = 'true', "cast" = 'boolean'
    `);

    (postgresClient as any).query = async(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
    (postgresClient as any).queryOne = async(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] ?? null;
    (postgresClient as any).queryAll = async(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
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
  });

  afterAll(async() => {
    (postgresClient as any).query = originalQuery;
    (postgresClient as any).queryOne = originalQueryOne;
    (postgresClient as any).queryAll = originalQueryAll;
    (postgresClient as any).transaction = originalTransaction;
    await pool?.end();
    await bootstrapPool?.query(`DROP SCHEMA IF EXISTS "${ schema }" CASCADE`);
    await bootstrapPool?.end();
  });

  async function crashAt(seam: typeof seams[number], taskId: string): Promise<void> {
    const worker = fileURLToPath(new URL('./fixtures/dispatcherCrashWorker.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', worker, connectionString!, schema, seam, taskId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    expect(output).toContain(`FAULT_READY:${ seam }`);
    expect(result.signal).toBe('SIGKILL');
  }

  async function bootAndAssertTruth(taskId: string): Promise<void> {
    await WorkTaskDispatchModel.recoverPendingOutcomeJournals();
    await WorkTaskDispatchModel.recoverStale(0);
    await DispatcherLivenessModel.beginTick(60_000);
    await DispatcherLivenessModel.completeTick(60_000, 'idle');

    const running = await pool.query(`SELECT id FROM work_task_dispatches WHERE status = 'running'`);
    expect(running.rows).toHaveLength(0);
    const stranded = await pool.query(`
      SELECT d.id FROM work_task_dispatches d JOIN work_tasks t ON t.id = d.task_id
       WHERE d.status = 'running' AND t.status IN ('done', 'in_review', 'blocked')
    `);
    expect(stranded.rows).toHaveLength(0);
    const liveness = await pool.query(`SELECT checking, last_outcome, last_tick_at FROM dispatcher_liveness WHERE id = true`);
    expect(liveness.rows[0]).toMatchObject({ checking: false, last_outcome: 'idle' });
    expect(liveness.rows[0].last_tick_at).not.toBeNull();
    const duplicatePullRequests = await pool.query(`
      SELECT task_id, COUNT(*)::int AS count FROM fault_soak_external_prs
       WHERE task_id = $1 GROUP BY task_id HAVING COUNT(*) > 1
    `, [taskId]);
    expect(duplicatePullRequests.rows).toHaveLength(0);
    const activeClaims = await pool.query(`SELECT id FROM work_task_stage_claims WHERE status = 'active'`);
    expect(activeClaims.rows).toHaveLength(0);
  }

  it.each(seams)('SIGKILL at %s converges on the next boot', async(seam) => {
    const taskId = `task-${ seam }`;
    await crashAt(seam, taskId);
    await bootAndAssertTruth(taskId);
  });
});
