// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { NobleCryptoPrimitives } from '@sulla/domain';
import { DEFAULT_AGENT_POLICY, encryptItem, type VaultItemPlaintext } from '@sulla/vault-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainVaultSyncCodec } from '../../../../../../services/sulla-vault/src/browserEnvelope/DomainVaultSyncCodec';
import { SodiumCryptoPrimitives } from '../../../../../../services/sulla-vault/src/browserEnvelope/SodiumCryptoPrimitives';
import { loadSodium, type SyncHead, type SyncRecord } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';
import { itemRecordFields, tombstoneFields } from '../../../../../../services/sulla-vault/src/browserEnvelope/exportBuilder';
import { CloudVaultSyncRunner } from '../../../../../../services/sulla-vault/src/browserEnvelope/syncRunner';
import type { Database } from '../../../../../../services/sulla-vault/src/db';

// The frozen v3 sync runner (SR) with its real Postgres repositories on a real schema
// (PGlite + the shipped migrations). Every statement SR or its repositories send goes
// through RecordingPgClient, on the pool and on transaction clients alike. Only Sulla
// Cloud's HTTP is faked, behind the authority port.

interface Inner {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number }>;
  connect?(): Promise<Inner>;
  release?(): void;
}

class EmbeddedDatabase implements Inner {
  private readonly pglite = new PGlite();
  async setup(): Promise<void> {
    const dir = resolve(process.cwd(), 'services/sulla-vault/migrations');
    for (const file of (await readdir(dir)).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort()) {
      await this.pglite.exec((await readFile(resolve(dir, file), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    }
  }
  async query<T>(sql: string, values?: unknown[]) {
    if (!values?.length) {
      // PGlite's extended protocol takes one statement; the sync schema is several, so run parameterless SQL through exec.
      const results = await this.pglite.exec(sql) as unknown as Array<{ rows: T[]; affectedRows?: number }>;
      const last = results[results.length - 1] ?? { rows: [] as T[] };
      return { rows: last.rows, rowCount: last.affectedRows ?? last.rows.length };
    }
    const r = await this.pglite.query<T>(sql, values) as { rows: T[]; affectedRows?: number };
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }
  async connect(): Promise<Inner> { return this; }
  release() {}
  close() { return this.pglite.close(); }
}

/** A pg Pool/PoolClient stand-in that logs every SQL statement, then forwards it unchanged. */
class RecordingPgClient {
  private static readonly WRITE = /\b(?:INSERT\s+INTO|(?<!\bDO\s+)UPDATE(?:\s+ONLY)?|DELETE\s+FROM(?:\s+ONLY)?|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;

  constructor(private readonly inner: Inner, readonly statements: string[] = []) {}

  query<T>(sql: string, values?: unknown[]) {
    this.statements.push(sql);
    return this.inner.query<T>(sql, values);
  }

  async connect(): Promise<RecordingPgClient> {
    return new RecordingPgClient(this.inner.connect ? await this.inner.connect() : this.inner, this.statements);
  }

  release() { this.inner.release?.(); }

  mark(): number { return this.statements.length; }

  /** Tables written (INSERT/UPDATE/DELETE/TRUNCATE/MERGE) by statements recorded since `from`. */
  writtenTables(from = 0): string[] {
    const tables = new Set<string>();
    for (const sql of this.statements.slice(from)) {
      for (const match of sql.matchAll(RecordingPgClient.WRITE)) tables.add(match[1].toLowerCase());
    }
    return [...tables].sort();
  }
}

const embedded = new EmbeddedDatabase();
const login = (name: string): VaultItemPlaintext => ({ type: 'login', name, username: 'u', password: 'p', agentPolicy: { ...DEFAULT_AGENT_POLICY } } as VaultItemPlaintext);

/** One synthetic local user, vault and Cloud. Cloud keeps the last head it accepted or served. */
class CustodyRig {
  readonly userId = randomUUID();
  readonly vaultId = randomUUID();
  readonly userKey = randomBytes(32);
  readonly db = new RecordingPgClient(embedded);
  private codec!: DomainVaultSyncCodec;
  private served: SyncRecord[] = [];
  private cloudHead!: SyncHead;
  private cloudRecords = new Map<string, SyncRecord>();
  runner!: CloudVaultSyncRunner;

  async setup(): Promise<this> {
    const sodium = await loadSodium();
    const crypto = new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives());
    this.codec = new DomainVaultSyncCodec(crypto, crypto);
    await embedded.query(
      `INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
       VALUES ($1,$2,$3,$4,'pk','{"ciphertext":"priv"}'::jsonb,'{"ciphertext":"key"}'::jsonb,'{"alg":"test"}'::jsonb)`,
      [this.userId, `custody-${ this.userId }@example.com`, Buffer.from('salt'), Buffer.from('verifier')],
    );
    await embedded.query(
      `INSERT INTO local_vault_recovery(user_id,recovery_salt,recovery_verifier,encrypted_user_key) VALUES ($1,'rsalt','rverifier','{"ciphertext":"recovery-wrap"}'::jsonb)`,
      [this.userId],
    );
    // The real runner with its default (real) repositories, over the recording client.
    this.runner = new CloudVaultSyncRunner(this.db as unknown as Database, this.authority(), { get: async() => this.codec } as never);
    await this.runner.status(); // ensureSyncSchema
    this.cloudHead = this.codec.buildHead({ vaultId: this.vaultId, scope: 'personal', seq: 1, records: [], prevHeadMac: '' }, this.userKey);
    await embedded.query(
      `INSERT INTO cloud_vault_sync_state(owner_user_id,vault_id,epoch,bundle_generation,head_seq,head_mac,bundle_sha) VALUES ($1,$2,1,1,1,$3,'local-wrap')`,
      [this.userId, this.vaultId, this.cloudHead.mac],
    );
    return this;
  }

  private async sealed(id: string, plaintext: VaultItemPlaintext) {
    return encryptItem(JSON.stringify(plaintext), this.userKey, { itemId: id, ownerId: this.userId });
  }

  private record(id: string, sealed: { ciphertext: unknown; encryptedItemKey: unknown }, generation: number): SyncRecord {
    return this.codec.buildRecord(itemRecordFields({ id, ciphertext: sealed.ciphertext, encrypted_item_key: sealed.encryptedItemKey } as never, { vaultId: this.vaultId, generation }), this.userKey);
  }

  /** A local item Cloud already holds at generation 1, no local edits. */
  async seedSynced(name: string): Promise<string> {
    const id = randomUUID();
    const sealed = await this.sealed(id, login(name));
    await embedded.query(
      `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy) VALUES ($1,$2,'login',$3::jsonb,$4::jsonb,$5::jsonb)`,
      [id, this.userId, JSON.stringify(sealed.ciphertext), JSON.stringify(sealed.encryptedItemKey), JSON.stringify(DEFAULT_AGENT_POLICY)],
    );
    const revision = (await embedded.query<{ revision: string }>(`SELECT revision FROM items WHERE id=$1`, [id])).rows[0].revision;
    const record = this.record(id, sealed, 1);
    this.cloudRecords.set(id, record);
    await embedded.query(
      `INSERT INTO cloud_vault_sync_records(owner_user_id,scope,record_id,generation,deleted,record_mac,local_revision) VALUES ($1,'personal',$2,1,false,$3,$4)`,
      [this.userId, id, record.mac, revision],
    );
    this.cloudHead = this.codec.buildHead({ vaultId: this.vaultId, scope: 'personal', seq: 1, records: this.cloudRecords.values(), prevHeadMac: '' }, this.userKey);
    await embedded.query(`UPDATE cloud_vault_sync_state SET head_mac=$2 WHERE owner_user_id=$1`, [this.userId, this.cloudHead.mac]);
    return id;
  }

  /** A new local item Cloud has never seen. */
  async createLocal(name: string): Promise<string> {
    const id = randomUUID();
    const sealed = await this.sealed(id, login(name));
    await embedded.query(
      `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy) VALUES ($1,$2,'login',$3::jsonb,$4::jsonb,$5::jsonb)`,
      [id, this.userId, JSON.stringify(sealed.ciphertext), JSON.stringify(sealed.encryptedItemKey), JSON.stringify(DEFAULT_AGENT_POLICY)],
    );
    return id;
  }

  /** The local human edits an item (new ciphertext, revision bumped). */
  async editLocal(id: string, name: string): Promise<void> {
    const sealed = await this.sealed(id, login(name));
    await embedded.query(`UPDATE items SET ciphertext=$3::jsonb,encrypted_item_key=$4::jsonb,revision=revision+1 WHERE id=$1 AND owner_user_id=$2`,
      [id, this.userId, JSON.stringify(sealed.ciphertext), JSON.stringify(sealed.encryptedItemKey)]);
  }

  /** Another device commits: edits, creations and deletions land on Cloud as one new head. */
  async cloudCommit(change: { edit?: Record<string, string>; create?: Record<string, string>; remove?: string[] }): Promise<void> {
    const delta: SyncRecord[] = [];
    for (const [id, name] of Object.entries({ ...change.edit, ...change.create })) {
      delta.push(this.record(id, await this.sealed(id, login(name)), (this.cloudRecords.get(id)?.generation ?? 0) + 1));
    }
    for (const id of change.remove ?? []) {
      delta.push(this.codec.buildRecord(tombstoneFields(id, { vaultId: this.vaultId, generation: this.cloudRecords.get(id)!.generation + 1 }), this.userKey));
    }
    for (const r of delta) this.cloudRecords.set(r.id, r);
    this.served = delta;
    this.cloudHead = this.codec.buildHead({
      vaultId: this.vaultId, scope: 'personal', seq: this.cloudHead.seq + 1, records: this.cloudRecords.values(), prevHeadMac: this.cloudHead.mac,
    }, this.userKey);
  }

  pull() { return this.runner.pull('device-0001'); }

  async push(): Promise<number> {
    const prepared = await this.runner.prepare('commit', 'device-0001');
    if ('idle' in prepared) return 0;
    const sent = await this.runner.send(prepared.handle, { ts: Date.now(), signature: 'sig' });
    expect(sent.ok).toBe(true);
    return 1;
  }

  /** Every row this user owns, in a stable order. Timestamps SR bumps on every pull are listed in `volatile`. */
  async snapshot(volatile: string[] = []) {
    const strip = (rows: Array<Record<string, unknown>>) => rows.map(row => Object.fromEntries(Object.entries(row).filter(([k]) => !volatile.includes(k))));
    const rows = async(sql: string) => (await embedded.query<Record<string, unknown>>(sql, [this.userId])).rows;
    return {
      users:     await rows(`SELECT * FROM users WHERE id=$1`),
      recovery:  await rows(`SELECT * FROM local_vault_recovery WHERE user_id=$1`),
      items:     await rows(`SELECT * FROM items WHERE owner_user_id=$1 ORDER BY id`),
      records:   await rows(`SELECT * FROM cloud_vault_sync_records WHERE owner_user_id=$1 ORDER BY record_id`),
      audit:     await rows(`SELECT id,item_id,action,metadata,blocked FROM audit_log WHERE actor_user_id=$1 ORDER BY id`),
      state:     strip(await rows(`SELECT * FROM cloud_vault_sync_state WHERE owner_user_id=$1`)),
    };
  }

  private authority() {
    return {
      withUnlockedUserKey: async<T>(operation: (keys: { userId: string; userKey: Uint8Array; assertCurrent: () => void }) => Promise<T>) =>
        operation({ userId: this.userId, userKey: this.userKey, assertCurrent: () => undefined }),
      sullaCloudRequest: async(input: { method: string; path: string; body?: string }) => {
        if (input.path.includes('/bundle?')) return { status: 404, headers: {}, body: {} };
        if (input.path.includes('/commit')) {
          const body = JSON.parse(Buffer.from(input.body ?? '', 'base64').toString()) as { writes: Array<{ record: SyncRecord }>; head: SyncHead };
          for (const write of body.writes) this.cloudRecords.set(write.record.id, write.record);
          this.cloudHead = body.head;
          this.served = [];
          return { status: 200, headers: {}, body: {} };
        }
        const records = this.served;
        this.served = [];
        return { status: 200, headers: {}, body: { head: this.cloudHead, records, nextCursor: '', syncPaused: false } };
      },
    };
  }
}

beforeAll(() => embedded.setup(), 60_000);
afterAll(() => embedded.close());

describe('frozen sync runner table custody (RecordingPgClient on the real runner + repositories)', () => {
  it('a full pull/push cycle never writes the users table and never rewraps the local vault key', async() => {
    // risk: key custody — sync must never touch the local account wrap (users / local_vault_recovery).
    const rig = await new CustodyRig().setup();
    const editedHere = await rig.seedSynced('Edited here');
    const editedThere = await rig.seedSynced('Edited on another device');
    const deletedThere = await rig.seedSynced('Deleted on another device');
    const createdHere = await rig.createLocal('Created here');
    const createdThere = randomUUID();
    await rig.editLocal(editedHere, 'Edited here v2');
    const keysBefore = await rig.snapshot();

    await rig.cloudCommit({ edit: { [editedThere]: 'Edited there v2' }, create: { [createdThere]: 'Created there' }, remove: [deletedThere] });
    const pulled = await rig.pull();
    const pushed = await rig.push();
    await rig.runner.status();

    // The cycle really ran through every write path (otherwise "no users write" proves nothing).
    expect(pulled).toMatchObject({ applied: 3, conflictCopies: 0, headSeq: 2 });
    expect(pushed).toBe(1);
    const after = await rig.snapshot();
    expect(after.items.find(i => i.id === deletedThere)?.deleted_at).not.toBeNull();
    expect(after.items.some(i => i.id === createdThere)).toBe(true);
    expect(after.records.map(r => r.record_id)).toEqual(expect.arrayContaining([editedHere, createdHere, createdThere]));
    expect(Number(after.state[0].head_seq)).toBe(3);
    expect(rig.db.writtenTables()).toEqual(['audit_log', 'cloud_vault_sync_records', 'cloud_vault_sync_state', 'items']);

    // Custody: no statement wrote `users` or the recovery wrap, and the rows are byte-identical.
    expect(rig.db.writtenTables()).not.toContain('users');
    expect(rig.db.writtenTables()).not.toContain('local_vault_recovery');
    expect(after.users).toEqual(keysBefore.users);
    expect(after.recovery).toEqual(keysBefore.recovery);
  }, 60_000);

  it('pulling an unchanged remote head leaves every row as it was', async() => {
    // risk: data accuracy — an idle pull must not create, change or delete items, ledger rows, audit rows or keys.
    const rig = await new CustodyRig().setup();
    const kept = await rig.seedSynced('Kept');
    await rig.editLocal(kept, 'Kept v2');
    await rig.createLocal('New here');
    await rig.cloudCommit({ create: { [randomUUID()]: 'From elsewhere' } });
    await rig.pull();
    await rig.push();
    const volatile = ['last_pull_at', 'updated_at'];
    const before = await rig.snapshot(volatile);
    const mark = rig.db.mark();

    const result = await rig.pull();

    expect(result).toMatchObject({ applied: 0, conflictCopies: 0, headSeq: 3 });
    expect(await rig.snapshot(volatile)).toEqual(before);
    // The only write an idle pull may make is stamping last_pull_at on its own state row.
    expect(rig.db.writtenTables(mark)).toEqual(['cloud_vault_sync_state']);
  }, 60_000);
});
