// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AbandonedRunReaper, type LockClient, type Queryable } from '../../../../../../services/sulla-workflows/src/AbandonedRunReaper';

class EmbeddedClient implements LockClient {
  constructor(private readonly db: PGlite) {}

  async query(sql: string, values?: unknown[]) {
    const result = await this.db.query<any>(sql, values) as { rows: any[]; affectedRows?: number };

    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  release(): void {}
}

/** The real workflow schema, on the CI Postgres when available, otherwise embedded Postgres. */
class WorkflowDatabase {
  private pool: pg.Pool | null = null;
  private pglite: PGlite | null = null;
  private embedded: EmbeddedClient | null = null;
  private schema = '';

  async setup(): Promise<void> {
    const url = process.env.SULLA_TEST_DATABASE_URL;
    if (url) {
      this.schema = `wf_reaper_${ randomUUID().replaceAll('-', '') }`;
      this.pool = new pg.Pool({ connectionString: url, options: `-csearch_path=${ this.schema },public` });
      await this.pool.query(`CREATE SCHEMA "${ this.schema }"`);
    } else {
      this.pglite = new PGlite();
      this.embedded = new EmbeddedClient(this.pglite);
    }
    const dir = resolve(process.cwd(), 'services/sulla-workflows/migrations');
    for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(resolve(dir, file), 'utf8');
      if (this.pglite) await this.pglite.exec(sql);
      else await this.pool!.query(sql);
    }
  }

  get db(): Queryable {
    return (this.pool ?? this.embedded)!;
  }

  async connect(): Promise<LockClient> {
    return this.pool ? this.pool.connect() : this.embedded!;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`);
      await this.pool.end();
    }
    await this.pglite?.close();
  }
}

class FakeRunnerProbe {
  readonly stopped: string[] = [];
  constructor(private readonly live = new Set<string>()) {}

  async runnerExists(runnerId: string): Promise<boolean> { return this.live.has(runnerId) }

  async stopRunner(runnerId: string): Promise<void> { this.stopped.push(runnerId) }
}

const database = new WorkflowDatabase();
const managerStartedAt = new Date();

interface RunRow {
  id:              string;
  status?:         string;
  runnerId?:       string | null;
  ownerId?:        string | null;
  leaseToken?:     string | null;
  heartbeatAt?:    string | null;
  leaseExpiresSql?: string;
  waitKind?:       string | null;
  updatedSql?:     string;
  location?:       string;
  checkpoint?:     boolean;
}

async function insertRun(row: RunRow): Promise<void> {
  const workflowId = `wf-${ row.id }`;
  await database.db.query(
    `INSERT INTO workflows (id,name,status,definition,location) VALUES ($1,'Test','production','{}'::jsonb,$2)`,
    [workflowId, row.location ?? 'desktop'],
  );
  await database.db.query(
    `INSERT INTO workflow_executions
       (execution_id,workflow_id,status,runner_id,owner_id,lease_token,heartbeat_at,lease_expires_at,wait_kind,started_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,${ row.leaseExpiresSql ?? 'NULL' },$8,NOW() - INTERVAL '10 days',${ row.updatedSql ?? 'NOW()' })`,
    [row.id, workflowId, row.status ?? 'running', row.runnerId ?? null, row.ownerId ?? null, row.leaseToken ?? null,
      row.heartbeatAt ?? null, row.waitKind ?? null],
  );
  if (row.checkpoint) {
    await database.db.query(
      `INSERT INTO workflow_checkpoints (execution_id,workflow_id,node_id,sequence,playbook_state) VALUES ($1,$2,'n1',1,'{}'::jsonb)`,
      [row.id, workflowId],
    );
  }
}

async function statusOf(id: string): Promise<{ status: string; terminal_reason: string | null }> {
  return (await database.db.query('SELECT status,terminal_reason FROM workflow_executions WHERE execution_id=$1', [id])).rows[0];
}

function reaper(probe: FakeRunnerProbe, events: string[], launching = new Set<string>()): AbandonedRunReaper {
  return new AbandonedRunReaper({
    db:          database.db,
    lockPool:    { connect: () => database.connect() },
    launcher:    probe,
    emit:        async(executionId, _workflowId, eventType) => { events.push(`${ executionId }:${ eventType }`) },
    isLaunching: executionId => launching.has(executionId),
    managerStartedAt,
    location:    'desktop',
  });
}

beforeAll(() => database.setup());
afterAll(() => database.close());
beforeEach(async() => {
  await database.db.query('DELETE FROM workflow_checkpoints');
  await database.db.query('DELETE FROM workflow_executions');
  await database.db.query('DELETE FROM workflows');
});

describe.sequential('AbandonedRunReaper', () => {
  // risk: data accuracy — a dead run with microsecond lease timestamps held the workflow's only concurrency slot for 10 days
  it('settles a run whose lease expired days ago even though its timestamps carry microseconds', async() => {
    await insertRun({
      id:              'wfp-stale',
      status:          'suspended',
      runnerId:        'runner-gone',
      ownerId:         'owner-1',
      leaseToken:      'lease-1',
      heartbeatAt:     '2026-11-02 13:25:00.591682+00',
      leaseExpiresSql: `'2026-11-05 21:46:08.169336+00'::timestamptz`,
      updatedSql:      `'2026-11-05 21:46:08.169336+00'::timestamptz`,
      checkpoint:      true,
    });
    const probe = new FakeRunnerProbe();
    const events: string[] = [];

    await expect(reaper(probe, events).reap()).resolves.toEqual(['wfp-stale']);
    await expect(statusOf('wfp-stale')).resolves.toEqual({ status: 'failed', terminal_reason: 'runner_lease_expired' });
    expect(probe.stopped).toEqual(['runner-gone']);
    expect(events).toEqual(['wfp-stale:workflow_failed']);
    // Idempotent: a second sweep has nothing left to settle and emits nothing more.
    await expect(reaper(probe, events).reap()).resolves.toEqual([]);
    expect(events).toHaveLength(1);
  });

  // risk: irreversible side effect — a healthy runner must never be failed and stopped
  it('leaves runs with a live lease, a lease inside the grace window, or a real wait alone', async() => {
    await insertRun({ id: 'live', runnerId: 'r1', ownerId: 'o1', leaseToken: 'l1', heartbeatAt: '2026-11-13 10:00:00.123456+00', leaseExpiresSql: `NOW() + INTERVAL '60 seconds'` });
    await insertRun({ id: 'late-heartbeat', runnerId: 'r2', ownerId: 'o2', leaseToken: 'l2', heartbeatAt: '2026-11-13 10:00:00.123456+00', leaseExpiresSql: `NOW() - INTERVAL '10 seconds'` });
    await insertRun({ id: 'timer-wait', status: 'suspended', waitKind: 'timer', heartbeatAt: '2026-11-01 10:00:00.123456+00', updatedSql: `NOW() - INTERVAL '3 days'`, checkpoint: true });
    const probe = new FakeRunnerProbe(new Set(['r1', 'r2']));

    await expect(reaper(probe, []).reap()).resolves.toEqual([]);
    for (const id of ['live', 'late-heartbeat']) await expect(statusOf(id)).resolves.toMatchObject({ status: 'running' });
    await expect(statusOf('timer-wait')).resolves.toMatchObject({ status: 'suspended' });
    expect(probe.stopped).toEqual([]);
  });

  // risk: data accuracy — an unowned resumed run whose launching manager died must not stay "running" forever
  it('settles an unowned run that was last touched before this manager started, unless it is launching now', async() => {
    const unowned = { runnerId: 'r-old', heartbeatAt: '2026-11-02 13:25:00.591682+00', updatedSql: `NOW() - INTERVAL '1 day'`, checkpoint: true };
    await insertRun({ id: 'resumed-orphan', ...unowned });
    await insertRun({ id: 'launching', ...unowned });

    await expect(reaper(new FakeRunnerProbe(), [], new Set(['launching'])).reap()).resolves.toEqual(['resumed-orphan']);
    await expect(statusOf('resumed-orphan')).resolves.toEqual({ status: 'failed', terminal_reason: 'manager_restarted_before_handshake' });
    await expect(statusOf('launching')).resolves.toMatchObject({ status: 'running' });
  });

  // risk: tenant isolation — a desktop manager must not settle server-location runs
  it('only reaps runs for its own workflow location and the requested workflow', async() => {
    const expired = { runnerId: 'r', ownerId: 'o', leaseToken: 'l', heartbeatAt: '2026-11-02 13:25:00.591682+00', leaseExpiresSql: `NOW() - INTERVAL '1 day'` };
    await insertRun({ id: 'server-run', location: 'server', ...expired });
    await insertRun({ id: 'other-workflow', ...expired });
    await insertRun({ id: 'target', ...expired });

    await expect(reaper(new FakeRunnerProbe(), []).reap('wf-target')).resolves.toEqual(['target']);
    await expect(statusOf('server-run')).resolves.toMatchObject({ status: 'running' });
    await expect(statusOf('other-workflow')).resolves.toMatchObject({ status: 'running' });
  });
});
