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

  it('expires ledger rows individually after 48 hours while newer keys still suppress', async() => {
    // risk: data accuracy — expired keys are removed without losing recent suppression.
    const thread = `retention-ledger-${ randomUUID() }`;
    await sentLedger.record(thread, ['old-key', 'new-key']);
    await database.query("UPDATE subject_memory.sent SET sent_at=NOW()-INTERVAL '49 hours' WHERE thread_id=$1 AND key='old-key'", [thread]);
    await sentLedger.deleteExpiredBatch();
    expect(await database.query('SELECT key FROM subject_memory.sent WHERE thread_id=$1', [thread])).toEqual([{ key: 'new-key' }]);
    expect(await sentLedger.activeKeys(thread)).toEqual(new Set(['new-key']));
    await database.query('DELETE FROM subject_memory.sent WHERE thread_id=$1', [thread]);
  });

  it('deletes checkpoints on successful completion and expires failed runs at 30 days only', async() => {
    // risk: resumability/data retention — successful state is discarded, failed state remains until its own 30-day age.
    const prefix = `retention-${ randomUUID() }`;
    const rows = [
      { id: `${prefix}-success`, status: 'running', age: 1 },
      { id: `${prefix}-failed-29`, status: 'failed', age: 29 },
      { id: `${prefix}-failed-31`, status: 'failed', age: 31 },
      { id: `${prefix}-running`, status: 'running', age: 31 },
      { id: `${prefix}-suspended`, status: 'suspended', age: 31 },
    ];
    for (const row of rows) {
      await database.query(`INSERT INTO workflow_executions (execution_id,workflow_id,workflow_name,workflow_slug,status,started_at,completed_at,updated_at)
        VALUES ($1,'retention-test','Retention test','retention-test',$2::text,NOW()-INTERVAL '40 days',
          CASE WHEN $2::text='failed' THEN NOW()-($3::int * INTERVAL '1 day') END,NOW()-INTERVAL '40 days')`, [row.id,row.status,row.age]);
      await database.query(`INSERT INTO workflow_checkpoints (execution_id,workflow_id,workflow_name,node_id,node_label,node_subtype,sequence,playbook_state,created_at)
        VALUES ($1,'retention-test','Retention test','node','Node','test',1,'{}'::jsonb,NOW()-($2::int * INTERVAL '1 day'))`, [row.id,row.age]);
    }
    const { WorkflowExecutionModel } = await import('../../database/models/WorkflowExecutionModel');
    await WorkflowExecutionModel.markCompleted(`${prefix}-success`);
    await checkpoints.deleteExpiredBatch();
    const remaining = await database.query<{ execution_id: string }>(`SELECT execution_id FROM workflow_checkpoints WHERE execution_id LIKE $1 ORDER BY execution_id`, [`${prefix}-%`]);
    expect(remaining.map(row => row.execution_id)).toEqual([`${prefix}-failed-29`,`${prefix}-running`,`${prefix}-suspended`]);
    await database.query('DELETE FROM workflow_checkpoints WHERE execution_id LIKE $1', [`${prefix}-%`]);
    await database.query('DELETE FROM workflow_executions WHERE execution_id LIKE $1', [`${prefix}-%`]);
  });

  it('drains more than one ledger batch in a single retention pass', async() => {
    // risk: storage growth — the hourly pass must outpace the ledger write rate across multiple pages.
    const prefix = `retention-batch-${ randomUUID() }`;
    await database.query(`INSERT INTO subject_memory.sent (thread_id,key,source,sent_at)
      SELECT $1, 'key-' || n, 'recall', NOW()-INTERVAL '3 days' FROM generate_series(1,1100) n`, [prefix]);
    const { DatabaseRetentionService } = await import('../../services/DatabaseRetentionService');
    await (new DatabaseRetentionService() as any).runOnce();
    expect(await database.query('SELECT key FROM subject_memory.sent WHERE thread_id=$1', [prefix])).toHaveLength(0);
  });
});
