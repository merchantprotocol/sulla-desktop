// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { NobleCryptoPrimitives } from '@sulla/domain';
import { DEFAULT_AGENT_POLICY, decryptItemText, encryptItem, type AgentPolicy, type VaultItemPlaintext } from '@sulla/vault-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainVaultSyncCodec } from '../../../../../../services/sulla-vault/src/browserEnvelope/DomainVaultSyncCodec';
import { SodiumCryptoPrimitives } from '../../../../../../services/sulla-vault/src/browserEnvelope/SodiumCryptoPrimitives';
import { loadSodium, type SyncRecord } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';
import { itemRecordFields } from '../../../../../../services/sulla-vault/src/browserEnvelope/exportBuilder';
import { PolicyWideningDecision } from '../../../../../../services/sulla-vault/src/browserEnvelope/PolicyWideningDecision';
import { CloudVaultSyncRunner } from '../../../../../../services/sulla-vault/src/browserEnvelope/syncRunner';
import type { Database } from '../../../../../../services/sulla-vault/src/db';

// Real Postgres schema (PGlite + the shipped migrations), real vault encryption, the real
// sync runner and record codec. Only Sulla Cloud's HTTP is faked, behind the authority port.
class EmbeddedDatabase {
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
      const results = await this.pglite.exec(sql) as Array<{ rows: T[]; affectedRows?: number }>;
      const last = results[results.length - 1] ?? { rows: [] as T[] };
      return { rows: last.rows, rowCount: last.affectedRows ?? last.rows.length };
    }
    const r = await this.pglite.query<T>(sql, values) as { rows: T[]; affectedRows?: number };
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }
  async connect() { return this; }
  release() {}
  close() { return this.pglite.close(); }
}

const database = new EmbeddedDatabase();
const HEAD_MAC = 'a'.repeat(43);
const agentsPolicy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({ ...DEFAULT_AGENT_POLICY, mode: 'agents', level: 'autofill', ...over });
const onlyMe = (): AgentPolicy => ({ ...DEFAULT_AGENT_POLICY });
const login = (name: string, agentPolicy: AgentPolicy): VaultItemPlaintext => ({ type: 'login', name, username: 'u', password: 'p', agentPolicy } as VaultItemPlaintext);

/** One local user + vault + Cloud, with helpers to seed local items and serve pulled records. */
class SyncRig {
  readonly userId = randomUUID();
  readonly vaultId = randomUUID();
  readonly userKey = randomBytes(32);
  readonly commits: Array<{ writes: Array<{ id: string; baseGeneration: number; record: SyncRecord }> }> = [];
  private served: SyncRecord[] = [];
  private headSeq = 1;
  private codec!: DomainVaultSyncCodec;
  runner!: CloudVaultSyncRunner;

  async setup(): Promise<this> {
    const sodium = await loadSodium();
    const crypto = new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives());
    this.codec = new DomainVaultSyncCodec(crypto, crypto);
    await database.query(`INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf) VALUES ($1,$2,$3,$4,'pk','{}'::jsonb,'{"ciphertext":"key"}'::jsonb,'{"alg":"test"}'::jsonb)`,
      [this.userId, `${ this.userId }@example.test`, Buffer.from('salt'), Buffer.from('verifier')]);
    this.runner = new CloudVaultSyncRunner(database as unknown as Database, this.authority(), { get: async() => this.codec } as never);
    await this.runner.status(); // creates the sync tables (ensureSyncSchema)
    await database.query(
      `INSERT INTO cloud_vault_sync_state(owner_user_id,vault_id,epoch,bundle_generation,head_seq,head_mac) VALUES ($1,$2,1,1,1,$3)`,
      [this.userId, this.vaultId, HEAD_MAC],
    );
    return this;
  }

  /** A local item that Cloud already holds at generation 1 and that has no local edits. */
  async seedSyncedItem(plaintext: VaultItemPlaintext, id = randomUUID()): Promise<string> {
    const sealed = await encryptItem(JSON.stringify(plaintext), this.userKey, { itemId: id, ownerId: this.userId });
    await database.query(
      `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)`,
      [id, this.userId, plaintext.type, JSON.stringify(sealed.ciphertext), JSON.stringify(sealed.encryptedItemKey), JSON.stringify(plaintext.agentPolicy)],
    );
    const row = await this.item(id);
    const record = this.codec.buildRecord(itemRecordFields({ id, ciphertext: row.ciphertext, encrypted_item_key: row.encrypted_item_key } as never, { vaultId: this.vaultId, generation: 1 }), this.userKey);
    await database.query(
      `INSERT INTO cloud_vault_sync_records(owner_user_id,scope,record_id,generation,deleted,record_mac,local_revision) VALUES ($1,'personal',$2,1,false,$3,$4)`,
      [this.userId, id, record.mac, row.revision],
    );
    return id;
  }

  /** Cloud now holds generation 2 of `id` with this body; the next pull delivers it. */
  async cloudEdits(id: string, plaintext: VaultItemPlaintext): Promise<void> {
    const sealed = await encryptItem(JSON.stringify(plaintext), this.userKey, { itemId: id, ownerId: this.userId });
    const known = (await database.query<{ generation: string }>(`SELECT generation FROM cloud_vault_sync_records WHERE owner_user_id=$1 AND record_id=$2`, [this.userId, id])).rows[0];
    this.served = [this.codec.buildRecord(itemRecordFields({ id, ciphertext: sealed.ciphertext, encrypted_item_key: sealed.encryptedItemKey } as never, { vaultId: this.vaultId, generation: Number(known?.generation ?? 0) + 1 }), this.userKey)];
  }

  pull() { return this.runner.pull('device-0001'); }

  /** The local human saves the item: new ciphertext, revision bumped (what localAuthority does). */
  async humanSaves(id: string, plaintext: VaultItemPlaintext): Promise<void> {
    const sealed = await encryptItem(JSON.stringify(plaintext), this.userKey, { itemId: id, ownerId: this.userId });
    await database.query(`UPDATE items SET ciphertext=$3::jsonb,encrypted_item_key=$4::jsonb,agent_policy=$5::jsonb,revision=revision+1 WHERE id=$1 AND owner_user_id=$2`,
      [id, this.userId, JSON.stringify(sealed.ciphertext), JSON.stringify(sealed.encryptedItemKey), JSON.stringify(plaintext.agentPolicy)]);
  }

  async item(id: string) {
    return (await database.query<{ revision: string; ciphertext: unknown; encrypted_item_key: unknown; agent_policy: AgentPolicy; deleted_at: string | null }>(
      `SELECT revision,ciphertext,encrypted_item_key,agent_policy,deleted_at FROM items WHERE id=$1 AND owner_user_id=$2`, [id, this.userId])).rows[0];
  }

  async plaintextOf(id: string): Promise<VaultItemPlaintext> {
    const row = await this.item(id);
    return JSON.parse(await decryptItemText({ version: 1, ciphertext: row.ciphertext as never, encryptedItemKey: row.encrypted_item_key as never }, this.userKey, { itemId: id, ownerId: this.userId })) as VaultItemPlaintext;
  }

  async syncRow(id: string) {
    return (await database.query<{ generation: string; policy_review_pending: boolean; held_record: unknown; local_revision: string | null }>(
      `SELECT generation,policy_review_pending,held_record,local_revision FROM cloud_vault_sync_records WHERE owner_user_id=$1 AND record_id=$2`, [this.userId, id])).rows[0];
  }

  async userRow() {
    return (await database.query<Record<string, unknown>>(`SELECT encrypted_user_key,kdf,public_key,encrypted_private_key FROM users WHERE id=$1`, [this.userId])).rows[0];
  }

  /** Commit what is pending; returns the writes Cloud received (empty when nothing is pending). */
  async commit(): Promise<Array<{ id: string; baseGeneration: number; record: SyncRecord }>> {
    const prepared = await this.runner.prepare('commit', 'device-0001');
    if ('idle' in prepared) return [];
    const sent = await this.runner.send(prepared.handle, { ts: Date.now(), signature: 'sig' });
    expect(sent.ok).toBe(true);
    return this.commits[this.commits.length - 1].writes;
  }

  private authority() {
    return {
      withUnlockedUserKey: async<T>(operation: (keys: { userId: string; userKey: Uint8Array; assertCurrent: () => void }) => Promise<T>) =>
        operation({ userId: this.userId, userKey: this.userKey, assertCurrent: () => undefined }),
      sullaCloudRequest: async(input: { method: string; path: string; body?: string }) => {
        if (input.path.includes('/bundle?')) return { status: 404, headers: {}, body: {} };
        if (input.path.includes('/commit')) {
          this.commits.push(JSON.parse(Buffer.from(input.body ?? '', 'base64').toString()));
          return { status: 200, headers: {}, body: {} };
        }
        const merged = new Map<string, SyncRecord>();
        const known = (await database.query<{ record_id: string; generation: string; deleted: boolean; record_mac: string }>(
          `SELECT record_id,generation,deleted,record_mac FROM cloud_vault_sync_records WHERE owner_user_id=$1`, [this.userId])).rows;
        for (const k of known) merged.set(k.record_id, { id: k.record_id, generation: Number(k.generation), deleted: k.deleted, mac: k.record_mac } as SyncRecord);
        for (const r of this.served) merged.set(r.id, r);
        const head = this.codec.buildHead({ vaultId: this.vaultId, scope: 'personal', seq: this.headSeq + 1, records: merged.values(), prevHeadMac: HEAD_MAC }, this.userKey);
        return { status: 200, headers: {}, body: { head, records: this.served, nextCursor: '', syncPaused: false } };
      },
    };
  }
}

beforeAll(() => database.setup(), 60_000);
afterAll(() => database.close());

describe('held policy widening on a Cloud pull', () => {
  it('holds a widening record: the local ciphertext, policy and revision stay exactly as they were', async() => {
    // risk: security — a remote edit must not widen agent access before the owner approves it.
    const rig = await new SyncRig().setup();
    const id = await rig.seedSyncedItem(login('Bank', onlyMe()));
    const before = await rig.item(id);
    const keysBefore = await rig.userRow();
    await rig.cloudEdits(id, login('Bank', agentsPolicy({ level: 'full' })));

    await rig.pull();

    const after = await rig.item(id);
    expect(after.ciphertext).toEqual(before.ciphertext);
    expect(after.encrypted_item_key).toEqual(before.encrypted_item_key);
    expect(after.agent_policy).toEqual(onlyMe());
    expect(after.revision).toBe(before.revision);
    expect((await rig.plaintextOf(id)).agentPolicy).toEqual(onlyMe());
    const row = await rig.syncRow(id);
    expect(row.policy_review_pending).toBe(true);
    expect(row.held_record).toMatchObject({ id, generation: 2 });
    expect(Number(row.generation)).toBe(2);
    expect(await rig.runner.status()).toMatchObject({ policyReviewPending: 1, pendingChanges: 0 });
    expect(await rig.userRow()).toEqual(keysBefore); // risk: key custody
  }, 30_000);

  it('approve applies the held record; nothing is pushed back', async() => {
    // risk: security + data integrity — approval is the only way the widened version lands.
    const rig = await new SyncRig().setup();
    const id = await rig.seedSyncedItem(login('Bank', onlyMe()));
    await rig.cloudEdits(id, login('Bank renamed', agentsPolicy({ level: 'full' })));
    await rig.pull();

    await rig.runner.heldApprove(id);

    const plaintext = await rig.plaintextOf(id);
    expect(plaintext.name).toBe('Bank renamed');
    expect(plaintext.agentPolicy).toEqual(agentsPolicy({ level: 'full' }));
    expect((await rig.item(id)).agent_policy).toEqual(agentsPolicy({ level: 'full' }));
    const row = await rig.syncRow(id);
    expect(row.policy_review_pending).toBe(false);
    expect(row.held_record).toBeNull();
    expect(await rig.runner.status()).toMatchObject({ policyReviewPending: 0, pendingChanges: 0 });
    expect(await rig.commit()).toEqual([]);
  }, 30_000);

  it('reject keeps the local version and pushes it over the held Cloud generation', async() => {
    // risk: security + data loss — rejecting must keep local data and tell Cloud, not silently accept.
    const rig = await new SyncRig().setup();
    const id = await rig.seedSyncedItem(login('Bank', onlyMe()));
    await rig.cloudEdits(id, login('Bank', agentsPolicy({ level: 'full' })));
    await rig.pull();
    const before = await rig.item(id);

    await rig.runner.heldReject(id);

    const after = await rig.item(id);
    expect(after.ciphertext).toEqual(before.ciphertext);
    expect((await rig.plaintextOf(id)).agentPolicy).toEqual(onlyMe());
    expect(await rig.syncRow(id)).toMatchObject({ policy_review_pending: false, held_record: null });
    const writes = await rig.commit();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id, baseGeneration: 2 });
    expect(writes[0].record.item?.ciphertext).toEqual(before.ciphertext);
  }, 30_000);

  it('a human save of a held item does not accept the widening and is not pushed over the held record', async() => {
    // risk: security — the half-applied bug: a later save used to carry the widened policy into the vault.
    const rig = await new SyncRig().setup();
    const id = await rig.seedSyncedItem(login('Bank', onlyMe()));
    await rig.cloudEdits(id, login('Bank', agentsPolicy({ level: 'full' })));
    await rig.pull();

    await rig.humanSaves(id, login('Bank (my edit)', onlyMe()));

    expect((await rig.plaintextOf(id)).agentPolicy).toEqual(onlyMe());
    expect(await rig.syncRow(id)).toMatchObject({ policy_review_pending: true });
    expect(await rig.runner.status()).toMatchObject({ policyReviewPending: 1, pendingChanges: 0 });
    expect(await rig.commit()).toEqual([]);
  }, 30_000);

  it.each([
    ['an allow-list is removed', agentsPolicy({ agents: ['agent-a'] }), agentsPolicy({ agents: [] })],
    ['an allow-list gains an agent', agentsPolicy({ agents: ['agent-a'] }), agentsPolicy({ agents: ['agent-a', 'agent-b'] })],
  ])('holds a record when %s', async(_name, local, remote) => {
    // risk: security — the old check ignored the agents allow-list, so these applied unreviewed.
    const rig = await new SyncRig().setup();
    const id = await rig.seedSyncedItem(login('Deploy key', local));
    const before = await rig.item(id);
    await rig.cloudEdits(id, login('Deploy key', remote));

    await rig.pull();

    expect((await rig.item(id)).ciphertext).toEqual(before.ciphertext);
    expect(await rig.syncRow(id)).toMatchObject({ policy_review_pending: true });
  }, 30_000);

  it('applies a record that does not widen, even when the rest of the item changed', async() => {
    // risk: data accuracy — ordinary remote edits must still sync.
    const rig = await new SyncRig().setup();
    const id = await rig.seedSyncedItem(login('Bank', agentsPolicy({ level: 'full' })));
    await rig.cloudEdits(id, login('Bank (new name)', agentsPolicy({ level: 'autofill' })));

    await rig.pull();

    const plaintext = await rig.plaintextOf(id);
    expect(plaintext.name).toBe('Bank (new name)');
    expect((await rig.item(id)).agent_policy).toEqual(agentsPolicy({ level: 'autofill' }));
    expect(await rig.syncRow(id)).toMatchObject({ policy_review_pending: false, held_record: null });
  }, 30_000);

  it('does not create a new local item from a widening record until approved', async() => {
    // risk: security — an item new to this device and already widened must not appear unreviewed.
    const rig = await new SyncRig().setup();
    const id = randomUUID();
    await rig.cloudEdits(id, login('From another device', agentsPolicy({ level: 'full' })));
    await rig.pull();
    expect(await rig.item(id)).toBeUndefined();
    expect(await rig.syncRow(id)).toMatchObject({ policy_review_pending: true });

    await rig.runner.heldApprove(id);

    expect((await rig.plaintextOf(id)).agentPolicy).toEqual(agentsPolicy({ level: 'full' }));
  }, 30_000);

  it('refuses to approve or reject an item that has nothing held', async() => {
    // risk: security — approve must not be a way to rewrite arbitrary items.
    const rig = await new SyncRig().setup();
    const id = await rig.seedSyncedItem(login('Bank', onlyMe()));
    await expect(rig.runner.heldApprove(id)).rejects.toMatchObject({ code: 'not_held' });
    await expect(rig.runner.heldReject(id)).rejects.toMatchObject({ code: 'not_held' });
  }, 30_000);

  it('items held by an older build: approve takes the ciphertext policy, reject re-seals the column policy', async() => {
    // risk: security — rows held before this fix have the widened policy in the ciphertext only.
    const rig = await new SyncRig().setup();
    const approveId = await rig.seedSyncedItem(login('Legacy A', agentsPolicy({ level: 'full' })));
    const rejectId = await rig.seedSyncedItem(login('Legacy B', agentsPolicy({ level: 'full' })));
    for (const id of [approveId, rejectId]) {
      await database.query(`UPDATE items SET agent_policy=$3::jsonb WHERE id=$1 AND owner_user_id=$2`, [id, rig.userId, JSON.stringify(onlyMe())]);
      await database.query(`UPDATE cloud_vault_sync_records SET policy_review_pending=true WHERE record_id=$1`, [id]);
    }
    expect((await rig.runner.heldList()).map(h => [h.id, h.legacy])).toEqual(expect.arrayContaining([[approveId, true], [rejectId, true]]));

    await rig.runner.heldApprove(approveId);
    await rig.runner.heldReject(rejectId);

    expect((await rig.item(approveId)).agent_policy).toEqual(agentsPolicy({ level: 'full' }));
    expect((await rig.plaintextOf(rejectId)).agentPolicy).toEqual(onlyMe());
    expect((await rig.commit()).map(w => w.id)).toEqual([rejectId]);
  }, 30_000);
});

describe('PolicyWideningDecision', () => {
  const decision = new PolicyWideningDecision();
  it('treats a missing expiry like "never" and still compares the allow-list', () => {
    // risk: security — an older stored policy without every field must not read as widened or equal by accident.
    const { expiresAt: _drop, ...noExpiry } = agentsPolicy({ agents: ['a'] });
    expect(decision.widens(noExpiry, agentsPolicy({ agents: ['a'] }))).toBe(false);
    expect(decision.widens(noExpiry, agentsPolicy({ agents: [] }))).toBe(true);
  });
});
