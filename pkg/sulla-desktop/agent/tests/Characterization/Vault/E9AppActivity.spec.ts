// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 app.ts characterization of GET /v1/human/activity against a real schema (PGlite with every
// vault migration): filters, tenant isolation, LIKE escaping, paging, the file-sink merge and
// metadata sanitising must return exactly what the frozen pre-refactor app returns.

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../../../../services/sulla-vault/src/app';
import { SYNC_SCHEMA_SQL } from '../../../../../../services/sulla-vault/src/browserEnvelope/schema';
import { createApp as createLegacyApp } from '../../Support/E9Legacy/app.legacy';
import { AuthorityDouble, VaultAppConfigFactory, VaultAppProbe, type VaultAppFactory } from '../../Support/Vault/E9VaultAppHarness';

import type { AuditFileEvent } from '../../../../../../services/sulla-vault/src/auditFileSink';
import type { Database } from '../../../../../../services/sulla-vault/src/db';

const USER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const ORG = '20000000-0000-4000-8000-000000000001';
const OWNED_ITEM = '40000000-0000-4000-8000-000000000001';
const FOREIGN_ITEM = '40000000-0000-4000-8000-000000000002';
const HUMAN = { origin: VaultAppConfigFactory.humanUiOrigin, cookie: 'sulla_vault_human=sess-1', 'x-csrf-token': 'csrf-1' };

class ActivityDatabase {
  private pglite: PGlite | null = null;
  private database: Database | null = null;

  get db(): Database {
    if (!this.database) throw new Error('database not initialized');
    return this.database;
  }

  async setup(): Promise<void> {
    const pglite = new PGlite();
    this.pglite = pglite;
    const client = {
      query: async(sql: string, values?: unknown[]) => {
        const result = await pglite.query(sql, values) as { rows: unknown[]; affectedRows?: number };
        return { rows: result.rows, rowCount: result.rows.length > 0 ? result.rows.length : result.affectedRows ?? 0 };
      },
      release: () => undefined,
    };
    this.database = Object.assign(client, { connect: async() => client }) as unknown as Database;
    const dir = resolve(process.cwd(), 'services/sulla-vault/migrations');
    for (const file of (await readdir(dir)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort()) {
      await pglite.exec((await readFile(resolve(dir, file), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    }
    await pglite.exec(SYNC_SCHEMA_SQL);
    await this.seed();
  }

  async close(): Promise<void> { await this.pglite?.close() }

  private async seed(): Promise<void> {
    for (const userId of [USER, OTHER]) {
      await this.db.query(`INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf) VALUES ($1,$2,$3,$4,'pk','{}'::jsonb,'{"ciphertext":"key"}'::jsonb,'{"alg":"test"}'::jsonb)`, [userId, `${ userId }@example.test`, Buffer.from('salt'), Buffer.from('verifier')]);
    }
    await this.db.query(`INSERT INTO orgs(id,encrypted_name,created_by) VALUES ($1,'{}'::jsonb,$2)`, [ORG, USER]);
    for (const [id, owner] of [[OWNED_ITEM, USER], [FOREIGN_ITEM, OTHER]]) {
      await this.db.query(`INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref) VALUES ($1,$2,'apiKey','{"ciphertext":"c"}'::jsonb,'{"ciphertext":"k"}'::jsonb,'{"mode":"agents","level":"autofill","agents":[],"sites":[]}'::jsonb,$3)`, [id, owner, `github/${ id }`]);
    }
    const rows: Array<[string, string | null, string | null, string, string | null, Record<string, unknown>, boolean, string | null, string]> = [
      [USER, null, OWNED_ITEM, 'vault_outbound_request', 'pod-a', { agentId: 'agent-one', operation: 'github.call', destination: 'https://api.github.com/x?q=1', junk: 'drop' }, false, null, '2026-01-01T00:00:01.000Z'],
      [USER, null, null, 'human_unlock', null, {}, false, null, '2026-01-02T00:00:00.000Z'],
      [USER, null, FOREIGN_ITEM, 'item_reveal', null, {}, false, null, '2026-01-02T06:00:00.000Z'],
      [USER, ORG, null, 'org_action', null, {}, false, null, '2026-01-02T07:00:00.000Z'],
      [USER, null, OWNED_ITEM, 'item_reveal', null, { agentName: 'Agent\u0001X', serviceId: 'bad id with spaces' }, true, 'policy', '2026-01-03T00:00:00.000Z'],
      [OTHER, null, null, 'human_unlock', null, {}, false, null, '2026-01-03T06:00:00.000Z'],
      [USER, null, null, 'agent_credential_use', 'pod-b', { requestedItemId: OWNED_ITEM, serviceId: 'svc', agentName: 'Helper', destination: 'not a url' }, false, null, '2026-01-04T00:00:00.000Z'],
      [USER, null, null, 'search_100%_done', null, { operation: 'back\\slash' }, false, null, '2026-01-05T00:00:00.000Z'],
      [USER, null, OWNED_ITEM, 'item_update', null, { agentId: 'agent-two', requestedItemId: 'not-a-uuid' }, false, null, '2026-01-06T00:00:00.123Z'],
      [USER, null, null, 'human_lock', null, {}, false, null, '2026-01-06T00:00:00.123Z'],
    ];
    for (const row of rows) {
      await this.db.query(`INSERT INTO audit_log(actor_user_id,org_id,item_id,action,pod_id,metadata,blocked,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::timestamptz)`, [row[0], row[1], row[2], row[3], row[4], JSON.stringify(row[5]), row[6], row[7], row[8]]);
    }
  }
}

const fileEvent = (event: Partial<AuditFileEvent> & Pick<AuditFileEvent, 'created_at' | 'action'>): AuditFileEvent => ({
  actor_user_id: USER, org_id: null, collection_id: null, item_id: null, pod_id: null, metadata: {}, blocked: false, reason: null, ...event,
});
const FILE_EVENTS: AuditFileEvent[] = [
  fileEvent({ created_at: '2026-01-07T00:00:00.000Z', action: 'vault_outbound_request', pod_id: 'pod-b', metadata: { operation: 'slack.post', agentId: 'agent-three' }, blocked: true, reason: 'denied' }),
  fileEvent({ created_at: '2026-01-03T12:00:00.000Z', action: 'agent_credential_use', item_id: OWNED_ITEM.toUpperCase(), metadata: { agentId: 'agent-two', destination: 'ftp://files.example.test/x' } }),
  fileEvent({ created_at: '2026-01-04T00:00:00.000Z', action: 'agent_credential_use', actor_user_id: OTHER }),
  fileEvent({ created_at: '2026-01-04T00:00:00.000Z', action: 'agent_credential_use', org_id: ORG }),
  fileEvent({ created_at: '2025-12-31T00:00:00.000Z', action: 'agent_credential_use', metadata: { destination: 'https://github.example.test/path' } }),
];

const queries = [
  '', '?limit=2', '?limit=2&offset=1', '?limit=0', '?limit=500', '?limit=abc&offset=-5', '?offset=3',
  '?offset=4999&limit=1', '?offset=6000', '?offset=200000', '?actor=agent', '?actor=human', '?actor=all', '?actor=bad',
  '?blocked=true', '?blocked=false', '?blocked=maybe', '?from=2026-01-03T00:00:00Z', '?from=garbage',
  `?item=${ OWNED_ITEM }`, `?item=${ OWNED_ITEM.toUpperCase() }`, '?item=not-a-uuid', '?query=github', '?query=%20AGENT-TWO%20',
  '?query=100%25_', '?query=back%5Cslash', `?query=${ 'x'.repeat(161) }`, '?query=%20%20', '?actor=agent&blocked=true&query=slack',
  '?item=a&item=b', '?actor=human&offset=1&limit=1',
];

class ActivityEquivalence {
  private readonly probe = new VaultAppProbe();
  private readonly config = new VaultAppConfigFactory();

  constructor(private readonly database: ActivityDatabase) {}

  async run(factory: VaultAppFactory, query: string, principals: Array<string | undefined>, phase = 'unlocked') {
    const authority = new AuthorityDouble(FILE_EVENTS);
    let statusCalls = 0;
    authority.on('humanSessionStatus', () => ({ phase }));
    authority.on('status', () => ({ principalId: principals[Math.min(statusCalls++, principals.length - 1)] }));
    const app = factory(this.database.db, this.config.create(), { localAuthority: authority.authority });
    const outcome = await this.probe.send(app, { method: 'GET', path: `/v1/human/activity${ query }`, headers: HUMAN });
    return { outcome, calls: authority.calls };
  }

  async compare(query: string, principals: Array<string | undefined> = [USER], phase = 'unlocked') {
    const legacy = await this.run(createLegacyApp as VaultAppFactory, query, principals, phase);
    const current = await this.run(createApp as VaultAppFactory, query, principals, phase);
    expect(current, query).toEqual(legacy);
    return legacy;
  }
}

describe('E9 app.ts characterization: human activity', () => {
  const database = new ActivityDatabase();
  const equivalence = new ActivityEquivalence(database);

  beforeAll(async() => { await database.setup() });
  afterAll(async() => { await database.close() });
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined) });
  afterEach(() => { vi.restoreAllMocks() });

  it.each(queries)('returns the legacy events for %s', async query => { // risk: audit tenant isolation and filter semantics
    const legacy = await equivalence.compare(query);
    expect([200, 400]).toContain(legacy.outcome.status);
  });

  it('returns only the caller\'s own non-org events with sanitised metadata', async() => { // risk: cross-tenant audit disclosure
    const legacy = await equivalence.compare('?limit=100');
    const events = (legacy.outcome.body as { events: Array<{ action: string; metadata: Record<string, string> }> }).events;
    expect(events.map(event => event.action)).not.toContain('org_action');
    expect(events.filter(event => event.action === 'item_reveal')).toHaveLength(1);
    expect(events.find(event => event.action === 'vault_outbound_request' && event.metadata.destination)?.metadata)
      .toEqual({ agentId: 'agent-one', operation: 'github.call', destination: 'https://api.github.com' });
  });

  it('refuses a locked session before reading', async() => { // risk: audit read while locked
    const legacy = await equivalence.compare('', [USER], 'pre-unlock');
    expect(legacy.outcome.status).toBe(423);
    expect(legacy.calls.map(call => call.method)).not.toContain('outboundAuditSink.readRecent');
  });

  it('refuses when no principal is unlocked', async() => { // risk: audit read without an owner
    expect((await equivalence.compare('', [undefined])).outcome.status).toBe(423);
  });

  it('refuses when the vault re-locks to another principal during the read', async() => { // risk: audit leaked across a lock
    const legacy = await equivalence.compare('', [USER, OTHER]);
    expect(legacy.outcome).toMatchObject({ status: 423, body: { error: 'vault_locked', message: 'Vault locked during audit request' } });
  });
});
