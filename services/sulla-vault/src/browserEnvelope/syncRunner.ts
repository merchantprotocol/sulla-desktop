// Passwords sync v3 runner inside the vault container (VAULT-E2E-DESIGN.md §4, §6.2, §9).
//
// The container is the only process holding the user key, so it builds every
// upload and applies every pull. Electron main only orchestrates:
//   pull()               container fetches deltas, verifies MACs + head, applies them
//   prepare(op)          container builds the body, keeps it, returns {handle, sha256, vaultId, op}
//   main signs           deviceMessage('vault-sync-v3', [userId, deviceId, vaultId, op, sha256, ts])
//   send(handle, sig)    container sends its stored body to Cloud with its own token
// Main never receives a body, a key or plaintext.

import { randomUUID, createHash } from 'node:crypto';

import {
  DEFAULT_AGENT_POLICY, decryptItemText, encryptItem,
  type AgentPolicy, type VaultItemPlaintext,
} from '@sulla/vault-crypto';

import { createSyncEnvelope, EnvelopeError, loadSodium, type SyncEnvelope, type SyncHead, type SyncRecord } from './envelope.js';
import { bundleFields, itemRecordFields, tombstoneFields, type LocalAccountRow } from './exportBuilder.js';
import { ensureSyncSchema } from './schema.js';

import type { Database } from '../db.js';
import type pg from 'pg';

export type SyncOp = 'enable' | 'replace' | 'commit' | 'pause' | 'resume' | 'delete';
type ServerOp = 'create' | 'replace' | 'commit' | 'pause' | 'resume' | 'delete';

export interface UnlockedUserKey {
  userId:        string;
  userKey:       Uint8Array;
  assertCurrent: () => void;
}

/** What the runner needs from LocalVaultAuthority (wired in app.ts; see browserEnvelope/README.md). */
export interface CloudSyncAuthority {
  withUnlockedUserKey<T>(operation: (keys: UnlockedUserKey) => Promise<T>): Promise<T>;
  sullaCloudRequest(input: {
    method: string; path: string; headers?: Record<string, string>; body?: string; bodyEncoding?: 'base64'; responseType?: 'json';
  }): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
}

export class CloudSyncError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
  }
}

interface StateRow {
  owner_user_id: string; vault_id: string; epoch: number; bundle_generation: number;
  head_seq: string | number; head_mac: string; last_push_at: string | null; last_pull_at: string | null; last_error: string | null;
}

interface KnownRow { record_id: string; generation: string | number; deleted: boolean; record_mac: string; local_revision: string | number | null; policy_review_pending: boolean }

interface PendingSend {
  handle:       string;
  op:           ServerOp;
  method:       string;
  path:         string;
  body:         Buffer;
  sha256:       string;
  vaultId:      string;
  userId:       string;
  stateVersion: number;
  expiresAt:    number;
  onSuccess:    (response: unknown, client: pg.PoolClient) => Promise<void>;
}

const HANDLE_TTL_MS = 60_000;
const PULL_PAGE = 100;
const MAX_WRITES = 256;
const MAX_COMMIT_BYTES = 1_900_000;
const POLICY_RANK = { metadata: 0, autofill: 1, full: 2 } as const;
const ITEM_TYPES = new Set(['login', 'note', 'card', 'identity', 'apiKey']);

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const num = (v: string | number | null | undefined) => Number(v ?? 0);

/** True when `next` grants agents anything `current` doesn't (§4: remote widening waits for the owner). */
export function policyWidens(current: AgentPolicy, next: AgentPolicy): boolean {
  if (next.mode !== 'agents') return false;
  if (current.mode !== 'agents') return true;
  if ((POLICY_RANK[next.level] ?? 3) > (POLICY_RANK[current.level] ?? -1)) return true;
  if (next.allowServerAgents && !current.allowServerAgents) return true;
  if (current.askFirst && !next.askFirst) return true;
  if (current.sites.length && (!next.sites.length || next.sites.some(site => !current.sites.includes(site)))) return true;
  if (current.expiresAt && (!next.expiresAt || Date.parse(next.expiresAt) > Date.parse(current.expiresAt))) return true;
  return false;
}

function parseRemoteItem(json: string): VaultItemPlaintext {
  const item = JSON.parse(json) as VaultItemPlaintext;
  const policy = item?.agentPolicy as AgentPolicy | undefined;
  if (!item || typeof item.name !== 'string' || !item.name.trim() || !ITEM_TYPES.has(item.type) || !policy ||
      !['only_me', 'agents'].includes(policy.mode) || !['metadata', 'autofill', 'full'].includes(policy.level) ||
      !Array.isArray(policy.sites) || !Array.isArray(policy.agents)) {
    throw new CloudSyncError('remote_item_invalid', 422, 'A Cloud item failed validation');
  }
  return item;
}

function responseBody(body: unknown): any {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body) } catch { return body }
}

export class CloudVaultSyncRunner {
  private envelope: SyncEnvelope | null = null;
  private readonly pending = new Map<string, PendingSend>();
  private stateVersion = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Database, private readonly authority: CloudSyncAuthority) {}

  private async env(): Promise<SyncEnvelope> {
    this.envelope ??= createSyncEnvelope(await loadSodium());
    return this.envelope;
  }

  /** Serialize runner operations: pulls, prepares and sends never interleave. */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async cloud(method: string, path: string, body?: Buffer, headers: Record<string, string> = {}) {
    const result = await this.authority.sullaCloudRequest({
      method, path, responseType: 'json',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: body.toString('base64'), bodyEncoding: 'base64' as const } : {}),
    });
    return { status: result.status, body: responseBody(result.body) };
  }

  private async state(userId: string): Promise<StateRow | null> {
    const result = await this.db.query<StateRow>('SELECT * FROM cloud_vault_sync_state WHERE owner_user_id=$1', [userId]);
    return result.rows[0] ?? null;
  }

  private async known(userId: string): Promise<Map<string, KnownRow>> {
    const result = await this.db.query<KnownRow>(
      `SELECT record_id,generation,deleted,record_mac,local_revision,policy_review_pending
         FROM cloud_vault_sync_records WHERE owner_user_id=$1 AND scope='personal'`, [userId],
    );
    return new Map(result.rows.map(row => [row.record_id, row]));
  }

  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Local sync status for Desktop > Profile. Metadata only. */
  async status(): Promise<Record<string, unknown>> {
    await ensureSyncSchema(this.db);
    return this.authority.withUnlockedUserKey(async({ userId }) => {
      const state = await this.state(userId);
      if (!state) return { configured: false };
      const review = await this.db.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM cloud_vault_sync_records WHERE owner_user_id=$1 AND policy_review_pending`, [userId],
      );
      // Local edits Cloud doesn't have yet: main debounces a push when this is non-zero.
      const pending = await this.db.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM items i
           LEFT JOIN cloud_vault_sync_records r ON r.owner_user_id=i.owner_user_id AND r.scope='personal' AND r.record_id=i.id
          WHERE i.owner_user_id=$1 AND i.collection_id IS NULL
            AND ((i.deleted_at IS NULL AND (r.record_id IS NULL OR r.deleted OR r.local_revision IS DISTINCT FROM i.revision))
              OR (i.deleted_at IS NOT NULL AND r.record_id IS NOT NULL AND NOT r.deleted))`, [userId],
      );
      return {
        configured: true, vaultId: state.vault_id, headSeq: num(state.head_seq), lastPushAt: state.last_push_at,
        lastPullAt: state.last_pull_at, lastError: state.last_error, policyReviewPending: num(review.rows[0]?.n),
        pendingChanges: num(pending.rows[0]?.n),
      };
    });
  }

  /**
   * Pull Cloud deltas, verify every record MAC and the signed head over the
   * merged state, then apply them. Anything that fails verification stops the
   * pull and changes nothing locally.
   */
  pull(deviceId: string): Promise<{ applied: number; conflictCopies: number; headSeq: number; syncPaused?: boolean; cloudMissing?: boolean }> {
    return this.exclusive(async() => {
      await ensureSyncSchema(this.db);
      const envelope = await this.env();
      return this.authority.withUnlockedUserKey(async({ userId, userKey, assertCurrent }) => {
        const state = await this.state(userId);
        if (!state) throw new CloudSyncError('sync_not_configured', 409, 'Cloud sync is not turned on');
        const since = num(state.head_seq);
        const deltas: SyncRecord[] = [];
        let head: SyncHead | null = null;
        let syncPaused = false;
        let cursor = '';
        for (let page = 0; page < 1000; page++) {
          const query = new URLSearchParams({ scope: 'personal', since: String(since), limit: String(PULL_PAGE), deviceId });
          if (cursor) query.set('cursor', cursor);
          const res = await this.cloud('GET', `/cloud-vault-sync/vaults/${ state.vault_id }/records?${ query }`);
          if (res.status === 404) return { applied: 0, conflictCopies: 0, headSeq: since, cloudMissing: true };
          if (res.status !== 200) throw new CloudSyncError('cloud_error', 502, `Sulla Cloud returned ${ res.status }`);
          syncPaused = Boolean(res.body.syncPaused);
          if (!head) head = res.body.head as SyncHead;
          else if ((res.body.head as SyncHead).seq !== head.seq) throw new CloudSyncError('head_moved', 409, 'Cloud changed during the pull; retry');
          deltas.push(...res.body.records as SyncRecord[]);
          cursor = res.body.nextCursor ?? '';
          if (!cursor) break;
        }
        if (!head) throw new CloudSyncError('cloud_error', 502, 'Sulla Cloud returned no head');
        const known = await this.known(userId);
        const merged = new Map<string, Pick<SyncRecord, 'id' | 'generation' | 'deleted' | 'mac'>>();
        for (const row of known.values()) merged.set(row.record_id, { id: row.record_id, generation: num(row.generation), deleted: row.deleted, mac: row.record_mac });
        for (const record of deltas) {
          envelope.verifyRecord(record, userKey, { vaultId: state.vault_id, scope: 'personal' });
          const prior = known.get(record.id);
          if (prior && record.generation < num(prior.generation)) throw new EnvelopeError('rollback', 'Cloud served an older record generation');
          merged.set(record.id, record);
        }
        envelope.verifyHead(head, userKey, { vaultId: state.vault_id, scope: 'personal', records: merged.values() as Iterable<SyncRecord>, minSeq: since });
        assertCurrent();
        let applied = 0;
        let conflictCopies = 0;
        await this.transaction(async client => {
          for (const record of deltas) {
            const prior = known.get(record.id);
            if (prior && num(prior.generation) === record.generation) continue;
            const outcome = await this.applyRecord(client, envelope, userId, userKey, record, prior);
            applied += 1;
            conflictCopies += outcome.conflictCopy ? 1 : 0;
          }
          await client.query(
            `UPDATE cloud_vault_sync_state SET head_seq=$2,head_mac=$3,last_pull_at=now(),last_error=NULL,updated_at=now() WHERE owner_user_id=$1`,
            [userId, head!.seq, head!.mac],
          );
          assertCurrent();
        });
        this.stateVersion += 1;
        return { applied, conflictCopies, headSeq: head.seq, syncPaused };
      });
    });
  }

  private async applyRecord(
    client: pg.PoolClient, envelope: SyncEnvelope, userId: string, userKey: Uint8Array, record: SyncRecord, prior: KnownRow | undefined,
  ): Promise<{ conflictCopy: boolean }> {
    const local = (await client.query<{ revision: string; deleted_at: string | null; agent_policy: AgentPolicy; integration_ref: string | null; ciphertext: unknown; encrypted_item_key: unknown; item_type: string }>(
      `SELECT revision,deleted_at,agent_policy,integration_ref,ciphertext,encrypted_item_key,item_type
         FROM items WHERE id=$1 AND owner_user_id=$2 AND collection_id IS NULL FOR UPDATE`, [record.id, userId],
    )).rows[0];
    const localChanged = Boolean(local && (!prior || num(prior.local_revision) !== num(local.revision)));
    let conflictCopy = false;
    let revision: number | null = local ? num(local.revision) : null;
    let pendingReview = prior?.policy_review_pending ?? false;

    if (record.deleted) {
      if (local && !local.deleted_at && localChanged) {
        // Edited here, deleted there: keep the local edit; the next commit writes it over the tombstone.
        await this.remember(client, userId, record, prior ? num(prior.local_revision) : null, pendingReview);
        return { conflictCopy: false };
      }
      if (local && !local.deleted_at) {
        const res = await client.query<{ revision: string }>(
          `UPDATE items SET deleted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 AND owner_user_id=$2 RETURNING revision`, [record.id, userId],
        );
        revision = num(res.rows[0]?.revision);
        await this.audit(client, userId, 'cloud_sync_item_deleted', record.id);
      }
      await this.remember(client, userId, record, revision, false);
      return { conflictCopy: false };
    }

    const plaintext = parseRemoteItem(envelope.decryptItem(record.item, userKey, userId, record.id));
    if (local && !local.deleted_at && localChanged) {
      // Both sides changed with no human present: keep both. Cloud keeps the id; the local version becomes a copy.
      const mine = JSON.parse(await decryptItemText(
        { version: 1, ciphertext: local.ciphertext as never, encryptedItemKey: local.encrypted_item_key as never }, userKey,
        { itemId: record.id, ownerId: userId },
      )) as VaultItemPlaintext;
      const copyId = randomUUID();
      const copy: VaultItemPlaintext = { ...mine, name: `${ mine.name } (conflict copy)`, agentPolicy: { ...DEFAULT_AGENT_POLICY }, integration: undefined };
      const sealed = await encryptItem(JSON.stringify(copy), userKey, { itemId: copyId, ownerId: userId });
      await client.query(
        `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref) VALUES ($1,$2,$3,$4,$5,$6,NULL)`,
        [copyId, userId, copy.type, sealed.ciphertext, sealed.encryptedItemKey, copy.agentPolicy],
      );
      await this.audit(client, userId, 'cloud_sync_conflict_copy', copyId);
      conflictCopy = true;
    }

    // Agent access never widens from a remote edit until the owner confirms it here.
    const currentPolicy: AgentPolicy = local && !local.deleted_at ? local.agent_policy : { ...DEFAULT_AGENT_POLICY };
    const widened = policyWidens(currentPolicy, plaintext.agentPolicy);
    const columnPolicy = widened ? currentPolicy : plaintext.agentPolicy;
    pendingReview = widened;
    if (local) {
      const res = await client.query<{ revision: string }>(
        `UPDATE items SET item_type=$3,ciphertext=$4,encrypted_item_key=$5,agent_policy=$6,deleted_at=NULL,revision=revision+1,updated_at=now()
          WHERE id=$1 AND owner_user_id=$2 RETURNING revision`,
        [record.id, userId, plaintext.type, record.item!.ciphertext, record.item!.encryptedItemKey, columnPolicy],
      );
      revision = num(res.rows[0]?.revision);
      await this.audit(client, userId, 'cloud_sync_item_updated', record.id);
    } else {
      const res = await client.query<{ revision: string }>(
        `INSERT INTO items(id,owner_user_id,item_type,ciphertext,encrypted_item_key,agent_policy,integration_ref)
         VALUES ($1,$2,$3,$4,$5,$6,NULL) RETURNING revision`,
        [record.id, userId, plaintext.type, record.item!.ciphertext, record.item!.encryptedItemKey, columnPolicy],
      );
      revision = num(res.rows[0]?.revision);
      await this.audit(client, userId, 'cloud_sync_item_created', record.id);
    }
    await this.remember(client, userId, record, revision, pendingReview);
    return { conflictCopy };
  }

  private async remember(client: pg.PoolClient, userId: string, record: Pick<SyncRecord, 'id' | 'generation' | 'deleted' | 'mac'>, localRevision: number | null, pendingReview: boolean) {
    await client.query(
      `INSERT INTO cloud_vault_sync_records(owner_user_id,scope,record_id,generation,deleted,record_mac,local_revision,policy_review_pending)
       VALUES ($1,'personal',$2,$3,$4,$5,$6,$7)
       ON CONFLICT(owner_user_id,scope,record_id) DO UPDATE SET generation=$3,deleted=$4,record_mac=$5,local_revision=$6,policy_review_pending=$7`,
      [userId, record.id, record.generation, record.deleted, record.mac, localRevision, pendingReview],
    );
  }

  private async audit(client: pg.PoolClient, userId: string, action: string, itemId: string | null) {
    await client.query(`INSERT INTO audit_log(actor_user_id,item_id,action,metadata,blocked) VALUES ($1,$2,$3,'{}'::jsonb,false)`, [userId, itemId, action]);
  }

  /** Build a body for `op`, keep it here, and return only what main must sign. */
  prepare(op: SyncOp, deviceId: string): Promise<{ handle: string; sha256: string; vaultId: string; op: ServerOp } | { idle: true }> {
    return this.exclusive(async() => {
      await ensureSyncSchema(this.db);
      const envelope = await this.env();
      return this.authority.withUnlockedUserKey(async({ userId, userKey }) => {
        const state = await this.state(userId);
        if (op === 'enable' || op === 'replace') return this.prepareCreate(envelope, userId, userKey, state, deviceId, op === 'replace');
        if (!state) throw new CloudSyncError('sync_not_configured', 409, 'Cloud sync is not turned on');
        if (op === 'commit') return this.prepareCommit(envelope, userId, userKey, state, deviceId);
        const method = op === 'delete' ? 'DELETE' : 'POST';
        const path = op === 'delete' ? `/cloud-vault-sync/vaults/${ state.vault_id }?deviceId=${ encodeURIComponent(deviceId) }`
          : `/cloud-vault-sync/vaults/${ state.vault_id }/${ op }?deviceId=${ encodeURIComponent(deviceId) }`;
        return this.stash(userId, op, method, path, Buffer.alloc(0), state.vault_id, async(_res, client) => {
          if (op === 'delete') {
            await client.query('DELETE FROM cloud_vault_sync_records WHERE owner_user_id=$1', [userId]);
            await client.query('DELETE FROM cloud_vault_sync_state WHERE owner_user_id=$1', [userId]);
          }
        });
      });
    });
  }

  private async prepareCreate(envelope: SyncEnvelope, userId: string, userKey: Uint8Array, state: StateRow | null, deviceId: string, replace: boolean) {
    const account = (await this.db.query<LocalAccountRow>(
      'SELECT id,public_key,encrypted_private_key,encrypted_user_key,kdf FROM users WHERE id=$1 AND disabled_at IS NULL', [userId],
    )).rows[0];
    if (!account) throw new CloudSyncError('vault_missing', 409, 'The local vault account is missing');
    const vaultId = replace || !state ? randomUUID() : state.vault_id;
    let fields;
    try {
      fields = bundleFields(account, { vaultId, epoch: 1, bundleGeneration: 1 });
    } catch (error) {
      throw new CloudSyncError('password_kdf_missing', 409, (error as Error).message);
    }
    const bundle = envelope.buildBundle(fields, userKey);
    const items = (await this.db.query<{ id: string; revision: string; ciphertext: unknown; encrypted_item_key: unknown }>(
      `SELECT id,revision,ciphertext,encrypted_item_key FROM items WHERE owner_user_id=$1 AND collection_id IS NULL AND deleted_at IS NULL ORDER BY id`, [userId],
    )).rows;
    const records = items.map(row => envelope.buildRecord(itemRecordFields(row, { vaultId, generation: 1 }), userKey));
    const head = envelope.buildHead({ vaultId, scope: 'personal', seq: 1, records, prevHeadMac: '' }, userKey);
    const body = Buffer.from(JSON.stringify({ bundle, scope: 'personal', records, head }));
    const serverOp: ServerOp = replace ? 'replace' : 'create';
    const revisions = new Map(items.map(row => [row.id, num(row.revision)]));
    return this.stash(userId, serverOp, 'PUT', `/cloud-vault-sync/vaults/${ vaultId }?op=${ serverOp }&deviceId=${ encodeURIComponent(deviceId) }`, body, vaultId, async(_res, client) => {
      await client.query('DELETE FROM cloud_vault_sync_records WHERE owner_user_id=$1', [userId]);
      await client.query(
        `INSERT INTO cloud_vault_sync_state(owner_user_id,vault_id,epoch,bundle_generation,head_seq,head_mac,last_push_at)
         VALUES ($1,$2,1,1,1,$3,now())
         ON CONFLICT(owner_user_id) DO UPDATE SET vault_id=$2,epoch=1,bundle_generation=1,head_seq=1,head_mac=$3,last_push_at=now(),last_error=NULL,updated_at=now()`,
        [userId, vaultId, head.mac],
      );
      for (const record of records) await this.remember(client, userId, record, revisions.get(record.id) ?? null, false);
    });
  }

  private async prepareCommit(envelope: SyncEnvelope, userId: string, userKey: Uint8Array, state: StateRow, deviceId: string) {
    const known = await this.known(userId);
    const rows = (await this.db.query<{ id: string; revision: string; deleted_at: string | null; ciphertext: unknown; encrypted_item_key: unknown }>(
      `SELECT id,revision,deleted_at,ciphertext,encrypted_item_key FROM items WHERE owner_user_id=$1 AND collection_id IS NULL ORDER BY id`, [userId],
    )).rows;
    const writes: Array<{ id: string; baseGeneration: number; record: SyncRecord }> = [];
    const revisions = new Map<string, number>();
    let bytes = 0;
    for (const row of rows) {
      if (writes.length >= MAX_WRITES || bytes > MAX_COMMIT_BYTES) break;
      const prior = known.get(row.id);
      const base = prior ? num(prior.generation) : 0;
      let record: SyncRecord | null = null;
      if (!row.deleted_at && (!prior || prior.deleted || num(prior.local_revision) !== num(row.revision))) {
        record = envelope.buildRecord(itemRecordFields(row, { vaultId: state.vault_id, generation: base + 1 }), userKey);
      } else if (row.deleted_at && prior && !prior.deleted) {
        record = envelope.buildRecord(tombstoneFields(row.id, { vaultId: state.vault_id, generation: base + 1 }), userKey);
      }
      if (!record) continue;
      writes.push({ id: row.id, baseGeneration: base, record });
      revisions.set(row.id, num(row.revision));
      bytes += JSON.stringify(record).length;
    }
    if (!writes.length) return { idle: true as const };
    const merged = new Map<string, Pick<SyncRecord, 'id' | 'generation' | 'deleted' | 'mac'>>();
    for (const row of known.values()) merged.set(row.record_id, { id: row.record_id, generation: num(row.generation), deleted: row.deleted, mac: row.record_mac });
    for (const write of writes) merged.set(write.id, write.record);
    const head = envelope.buildHead({
      vaultId: state.vault_id, scope: 'personal', seq: num(state.head_seq) + 1, records: merged.values() as Iterable<SyncRecord>, prevHeadMac: state.head_mac,
    }, userKey);
    const body = Buffer.from(JSON.stringify({ scope: 'personal', expectedHeadSeq: num(state.head_seq), writes, head }));
    return this.stash(userId, 'commit', 'POST', `/cloud-vault-sync/vaults/${ state.vault_id }/commit?deviceId=${ encodeURIComponent(deviceId) }`, body, state.vault_id, async(_res, client) => {
      await client.query(
        `UPDATE cloud_vault_sync_state SET head_seq=$2,head_mac=$3,last_push_at=now(),last_error=NULL,updated_at=now() WHERE owner_user_id=$1`,
        [userId, head.seq, head.mac],
      );
      for (const write of writes) await this.remember(client, userId, write.record, revisions.get(write.id) ?? null, known.get(write.id)?.policy_review_pending ?? false);
    });
  }

  private stash(userId: string, op: ServerOp, method: string, path: string, body: Buffer, vaultId: string, onSuccess: PendingSend['onSuccess']) {
    const now = Date.now();
    for (const [key, entry] of this.pending) if (entry.expiresAt < now) this.pending.delete(key);
    const handle = randomUUID();
    const sha256 = sha256Hex(body);
    this.pending.set(handle, { handle, op, method, path, body, sha256, vaultId, userId, stateVersion: this.stateVersion, expiresAt: now + HANDLE_TTL_MS, onSuccess });
    return { handle, sha256, vaultId, op };
  }

  /** Send a prepared body with main's device signature. The body never leaves this process otherwise. */
  send(handle: string, proof: { ts: number; signature: string }): Promise<{ ok: boolean; status: number; error?: string; detail?: unknown }> {
    return this.exclusive(async() => {
      const entry = this.pending.get(handle);
      this.pending.delete(handle);
      if (!entry || entry.expiresAt < Date.now()) throw new CloudSyncError('handle_expired', 410, 'Prepared sync expired; prepare again');
      if (entry.stateVersion !== this.stateVersion) throw new CloudSyncError('handle_stale', 409, 'Local sync state changed; prepare again');
      if (!Number.isSafeInteger(proof?.ts) || typeof proof.signature !== 'string' || proof.signature.length > 128) {
        throw new CloudSyncError('invalid_proof', 400, 'Device signature is required');
      }
      return this.authority.withUnlockedUserKey(async({ userId, assertCurrent }) => {
        if (userId !== entry.userId) throw new CloudSyncError('handle_stale', 409, 'Vault changed; prepare again');
        const res = await this.cloud(entry.method, entry.path, entry.body.length ? entry.body : undefined, {
          'x-sulla-timestamp': String(proof.ts), 'x-sulla-device-signature': proof.signature,
        });
        if (res.status >= 200 && res.status < 300) {
          assertCurrent();
          await this.transaction(client => entry.onSuccess(res.body, client));
          this.stateVersion += 1;
          return { ok: true, status: res.status, detail: res.body };
        }
        const error = typeof res.body?.error === 'string' ? res.body.error : `http_${ res.status }`;
        await this.db.query('UPDATE cloud_vault_sync_state SET last_error=$2,updated_at=now() WHERE owner_user_id=$1', [userId, error]).catch(() => undefined);
        return { ok: false, status: res.status, error, detail: res.status === 409 ? res.body : undefined };
      });
    });
  }

  /** Forget local sync bookkeeping (after the Cloud copy is gone). Local items are untouched. */
  forget(): Promise<void> {
    return this.exclusive(async() => {
      await ensureSyncSchema(this.db);
      await this.authority.withUnlockedUserKey(async({ userId }) => {
        await this.db.query('DELETE FROM cloud_vault_sync_records WHERE owner_user_id=$1', [userId]);
        await this.db.query('DELETE FROM cloud_vault_sync_state WHERE owner_user_id=$1', [userId]);
      });
      this.stateVersion += 1;
    });
  }
}
