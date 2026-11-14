// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TestDatabase } from '../Support/TestDatabase';

const dbDescribe = TestDatabase.available() ? describe : process.env.CI ? describe : describe.skip;

dbDescribe('database retention with real Postgres', () => {
  const database = new TestDatabase();
  let postgres: typeof import('../../database/PostgresClient').postgresClient;
  let sentLedger: InstanceType<typeof import('../../database/models/SubjectMemorySentModel').SubjectMemorySentModel>;
  let checkpoints: typeof import('../../database/models/WorkflowCheckpointModel').WorkflowCheckpointModel;

  beforeAll(async() => {
    await database.initialize();
    process.env.SULLA_DATABASE_URL = database.appUrl();
    process.env.PGOPTIONS = `-csearch_path=${ database.schema },public`;
    process.env.SULLA_DATABASE_POOL_MAX = '1';
    postgres = (await import('../../database/PostgresClient')).postgresClient;
    await postgres.initialize();
    await postgres.query(`SET search_path TO "${ database.schema }", public`);
    sentLedger = new (await import('../../database/models/SubjectMemorySentModel')).SubjectMemorySentModel();
    checkpoints = (await import('../../database/models/WorkflowCheckpointModel')).WorkflowCheckpointModel;
  }, 60_000);

  afterAll(async() => database.dispose());

  it('clears a thread ledger by deleting rows while later recalls can suppress again', async() => {
    // risk: active-thread suppression must reset without retaining an unbounded cleared ledger.
    const threadId = `retention-clear-${ randomUUID() }`;
    await sentLedger.record(threadId, ['e:before-reset']);
    expect(await sentLedger.activeKeys(threadId)).toEqual(new Set(['e:before-reset']));
    await sentLedger.clearThread(threadId);
    expect(await database.query('SELECT key FROM subject_memory.sent WHERE thread_id=$1', [threadId])).toHaveLength(0);
    await sentLedger.record(threadId, ['e:after-reset']);
    expect(await sentLedger.activeKeys(threadId)).toEqual(new Set(['e:after-reset']));
    await database.query('DELETE FROM subject_memory.sent WHERE thread_id=$1', [threadId]);
  });

  it('prunes only idle-thread rows and preserves active-thread suppression keys', async() => {
    // risk: data accuracy — an active thread must never lose its suppression ledger.
    const active = `retention-active-${ randomUUID() }`;
    const idle = `retention-idle-${ randomUUID() }`;
    await sentLedger.record(active, ['e:active']);
    await sentLedger.record(idle, ['e:idle']);
    await database.query("UPDATE subject_memory.sent SET sent_at=NOW()-INTERVAL '15 days' WHERE thread_id=$1", [idle]);
    await sentLedger.deleteExpiredBatch();
    expect(await sentLedger.activeKeys(active)).toEqual(new Set(['e:active']));
    expect(await sentLedger.activeKeys(idle)).toEqual(new Set());
    await database.query('DELETE FROM subject_memory.sent WHERE thread_id=$1', [active]);
  });

  it('keeps running, suspended, and recent checkpoints while deleting old terminal checkpoints', async() => {
    // risk: resumability — checkpoints for live or recent runs must remain available to restart_from_checkpoint.
    const prefix = `retention-${ randomUUID() }`;
    const executions = [
      { id: `${ prefix }-running`, status: 'running', old: true },
      { id: `${ prefix }-suspended`, status: 'suspended', old: true },
      { id: `${ prefix }-recent`, status: 'completed', old: false },
      { id: `${ prefix }-finished`, status: 'failed', old: true },
    ];
    for (const execution of executions) {
      await database.query(`INSERT INTO workflow_executions (execution_id,workflow_id,workflow_name,workflow_slug,status,started_at,completed_at,updated_at)
        VALUES ($1,'retention-test','Retention test','retention-test',$2,NOW()-INTERVAL '15 days',
          CASE WHEN $2 IN ('completed','failed') THEN NOW() - CASE WHEN $3 THEN INTERVAL '15 days' ELSE INTERVAL '1 day' END END,
          NOW()-INTERVAL '15 days')`, [execution.id, execution.status, execution.old]);
      await database.query(`INSERT INTO workflow_checkpoints (execution_id,workflow_id,workflow_name,node_id,node_label,node_subtype,sequence,playbook_state)
        VALUES ($1,'retention-test','Retention test','node','Node','test',1,'{}'::jsonb)`, [execution.id]);
    }
    await checkpoints.deleteExpiredBatch();
    const rows = await database.query<{ execution_id: string }>(`SELECT execution_id FROM workflow_checkpoints WHERE execution_id LIKE $1 ORDER BY execution_id`, [`${ prefix }-%`]);
    expect(rows.map(row => row.execution_id)).toEqual([
      `${ prefix }-recent`, `${ prefix }-running`, `${ prefix }-suspended`,
    ]);
    await database.query('DELETE FROM workflow_checkpoints WHERE execution_id LIKE $1', [`${ prefix }-%`]);
    await database.query('DELETE FROM workflow_executions WHERE execution_id LIKE $1', [`${ prefix }-%`]);
  });
});
