// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

import { HeadChainLinkPolicy } from '@sulla/domain';
import {
  DEFAULT_AGENT_POLICY, decryptItemText, encryptItem,
  type AgentPolicy, type VaultItemPlaintext,
} from '@sulla/vault-crypto';

import { CloudSyncError } from './CloudSyncError.js';
import { EnvelopeError, type SyncBundle, type SyncHead, type SyncRecord } from './envelope.js';
import type { DomainVaultSyncCodec } from './DomainVaultSyncCodec.js';
import { HeldRecordService, type HeldSummary } from './HeldRecordService.js';
import { PolicyWideningDecision } from './PolicyWideningDecision.js';
import { RemoteItemParser } from './RemoteItemParser.js';
import { DomainVaultSyncCodecProvider } from './DomainVaultSyncCodecProvider.js';
import { bundleFields, itemRecordFields, tombstoneFields, type LocalAccountRow, type LocalRecoveryRow } from './exportBuilder.js';
import { ensureSyncSchema } from './schema.js';
import { CloudSyncRepositories } from './sync/CloudSyncRepositories.js';
import type { SyncAuditAction } from './sync/repositories/SyncAuditEventDispatcher.js';
import { DesktopSyncCommitBudget } from './sync/DesktopSyncCommitBudget.js';
import type { KnownRecordRow } from './sync/repositories/PostgresVerifiedRecordSet.js';
import type { SyncStateRow } from './sync/repositories/PostgresSyncStateRepository.js';

import type { Database, Queryable } from '../db.js';
import type pg from 'pg';

export type SyncOp = 'enable' | 'replace' | 'commit' | 'rewrap' | 'pause' | 'resume' | 'delete';
type ServerOp = 'create' | 'replace' | 'commit' | 'rewrap' | 'pause' | 'resume' | 'delete';

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

export { CloudSyncError };

type StateRow = SyncStateRow;
type KnownRow = KnownRecordRow;

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
// Rollout gate: enable only after Cloud, Web and Mobile all advertise bundle-v2 support.
const BUNDLE_V2_UPLOAD_ENABLED = process.env.SULLA_CLOUD_BUNDLE_VERSION === '2';

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Fingerprint of what the bundle wraps; changes on a password change, KDF change or key rotation. */
const wrapFingerprint = (account: LocalAccountRow, recovery?: unknown) => sha256Hex(Buffer.from(JSON.stringify([
  account.kdf, account.encrypted_user_key, account.public_key, account.encrypted_private_key, recovery ?? null,
])));
const num = (v: string | number | null | undefined) => Number(v ?? 0);

function responseBody(body: unknown): any {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body) } catch { return body }
}

export class CloudVaultSyncRunner {
  private envelope: DomainVaultSyncCodec | null = null;
  private readonly pending = new Map<string, PendingSend>();
  private stateVersion = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly widening = new PolicyWideningDecision();
  private readonly remoteItems = new RemoteItemParser();

  constructor(
    private readonly db: Database,
    private readonly authority: CloudSyncAuthority,
    private readonly codecProvider: DomainVaultSyncCodecProvider = new DomainVaultSyncCodecProvider(),
    private readonly repos: CloudSyncRepositories = new CloudSyncRepositories(),
    private readonly headChainLinkPolicy: HeadChainLinkPolicy = new HeadChainLinkPolicy(),
    private readonly commitBudget: DesktopSyncCommitBudget = new DesktopSyncCommitBudget(),
  ) {}

  private async env() {
    this.envelope ??= await this.codecProvider.get();
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

  private account(userId: string): Promise<LocalAccountRow | null> {
    return this.repos.accounts.account(this.db, userId);
  }

  private recovery(userId: string): Promise<LocalRecoveryRow | null> {
    return this.repos.accounts.recovery(this.db, userId);
  }

  private state(userId: string): Promise<StateRow | null> {
    return this.repos.state.find(this.db, userId);
  }

  private known(userId: string): Promise<Map<string, KnownRow>> {
    return this.repos.records.known(this.db, userId);
  }

  private transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.repos.transaction.run(this.db, operation);
  }

  /** Local sync status for Desktop > Profile. Metadata only. */
  async status(): Promise<Record<string, unknown>> {
    await ensureSyncSchema(this.db);
    return this.authority.withUnlockedUserKey(async({ userId }) => {
      const state = await this.state(userId);
      if (!state) return { configured: false };
      const review = await this.repos.pending.policyReviewCount(this.db, userId);
      // Local edits Cloud doesn't have yet: main debounces a push when this is non-zero.
      const pending = await this.repos.pending.pendingChangeCount(this.db, userId);
      const account = await this.account(userId);
      const recovery = BUNDLE_V2_UPLOAD_ENABLED ? await this.recovery(userId) : null;
      return {
        configured: true, vaultId: state.vault_id, headSeq: num(state.head_seq), lastPushAt: state.last_push_at,
        lastPullAt: state.last_pull_at, lastError: state.last_error, policyReviewPending: num(review),
        pendingChanges: num(pending),
        // The master password (or KDF) changed since the last upload: the Cloud bundle needs a rewrap.
        bundleStale: Boolean(account && state.bundle_sha && wrapFingerprint(account, recovery) !== state.bundle_sha),
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
        let remoteBundle: SyncBundle | null = null;
        const bundleResponse = await this.cloud('GET', `/cloud-vault-sync/vaults/${ state.vault_id }/bundle?deviceId=${ encodeURIComponent(deviceId) }`);
        if (bundleResponse.status === 200) remoteBundle = (bundleResponse.body.bundle ?? bundleResponse.body) as SyncBundle;
        else if (bundleResponse.status !== 404) throw new CloudSyncError('cloud_error', 502, `Sulla Cloud returned ${ bundleResponse.status } for the vault wrap`);
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
        if (remoteBundle) {
          envelope.verifyBundle(remoteBundle, userKey);
          if (remoteBundle.vaultId !== state.vault_id || remoteBundle.vaultUserId !== userId || remoteBundle.epoch !== num(state.epoch)) {
            throw new CloudSyncError('bundle_moved', 409, 'Cloud wrap belongs to another vault');
          }
          if (remoteBundle.bundleGeneration < num(state.bundle_generation)) throw new CloudSyncError('integrity_failed', 409, 'Cloud served an older wrap');
        }
        const known = await this.known(userId);
        const merged = new Map<string, Pick<SyncRecord, 'id' | 'generation' | 'deleted' | 'mac'>>();
        for (const row of known.values()) merged.set(row.record_id, { id: row.record_id, generation: num(row.generation), deleted: row.deleted, mac: row.record_mac });
        for (const record of deltas) {
          envelope.verifyRecord(record, userKey, { vaultId: state.vault_id, scope: 'personal' });
          const prior = known.get(record.id);
          if (prior && record.generation < num(prior.generation)) throw new EnvelopeError('rollback', 'Cloud served an older record generation');
          merged.set(record.id, record);
        }
        envelope.verifyHead(head, userKey, {
          vaultId: state.vault_id,
          scope: 'personal',
          records: merged.values() as Iterable<SyncRecord>,
          minSeq: since,
          // A head links to exactly one predecessor. The locally stored MAC can
          // be checked only for a one-step advance (or the unchanged head).
          ...(this.headChainLinkPolicy.expectedPreviousMac(head.seq, since, state.head_mac) !== undefined
            ? { expectedPrevHeadMac: state.head_mac } : {}),
        });
        assertCurrent();
        let applied = 0;
        let conflictCopies = 0;
        await this.transaction(async client => {
          if (remoteBundle && remoteBundle.bundleGeneration > num(state.bundle_generation)) {
            // Cloud's bundle is a password-wrapped copy for other devices. This
            // Desktop must retain its locally authoritative user-key wrapping.
            await this.repos.state.recordBundleGeneration(client, userId, remoteBundle.bundleGeneration);
          }
          for (const record of deltas) {
            const prior = known.get(record.id);
            if (prior && num(prior.generation) === record.generation) continue;
            const outcome = await this.applyRecord(client, envelope, userId, userKey, record, prior);
            applied += 1;
            conflictCopies += outcome.conflictCopy ? 1 : 0;
          }
          await this.repos.state.advancePulledHead(client, userId, head!.seq, head!.mac);
          assertCurrent();
        });
        this.stateVersion += 1;
        return { applied, conflictCopies, headSeq: head.seq, syncPaused };
      });
    });
  }

  private async applyRecord(
    client: pg.PoolClient, envelope: DomainVaultSyncCodec, userId: string, userKey: Uint8Array, record: SyncRecord, prior: KnownRow | undefined,
  ): Promise<{ conflictCopy: boolean }> {
    const local = await this.repos.items.lockForApply(client, userId, record.id);
    const localChanged = Boolean(local && (!prior || num(prior.local_revision) !== num(local.revision)));
    let conflictCopy = false;
    let revision: number | null = local ? num(local.revision) : null;

    if (record.deleted) {
      if (local && !local.deleted_at && localChanged) {
        // Edited here, deleted there: keep the local edit; the next commit writes it over the tombstone.
        await this.remember(client, userId, record, prior ? num(prior.local_revision) : null);
        return { conflictCopy: false };
      }
      if (local && !local.deleted_at) {
        revision = num(await this.repos.items.softDelete(client, userId, record.id));
        await this.audit(client, userId, 'cloud_sync_item_deleted', record.id);
      }
      await this.remember(client, userId, record, revision);
      return { conflictCopy: false };
    }

    if (!record.item) throw new EnvelopeError('malformed_record', 'Cloud record is missing its item body');
    const plaintext = this.remoteItems.parse(envelope.decryptItem(record.item, userKey, userId, record.id));
    if (local && !local.deleted_at && localChanged) {
      // Both sides changed with no human present: keep both. Cloud keeps the id; the local version becomes a copy.
      const mine = JSON.parse(await decryptItemText(
        { version: 1, ciphertext: local.ciphertext as never, encryptedItemKey: local.encrypted_item_key as never }, userKey,
        { itemId: record.id, ownerId: userId },
      )) as VaultItemPlaintext;
      const copyId = randomUUID();
      const copy: VaultItemPlaintext = { ...mine, name: `${ mine.name } (conflict copy)`, agentPolicy: { ...DEFAULT_AGENT_POLICY }, integration: undefined };
      const sealed = await encryptItem(JSON.stringify(copy), userKey, { itemId: copyId, ownerId: userId });
      await this.repos.items.insertConflictCopy(client, userId, copyId, copy.type, sealed.ciphertext, sealed.encryptedItemKey, copy.agentPolicy);
      await this.audit(client, userId, 'cloud_sync_conflict_copy', copyId);
      conflictCopy = true;
    }

    // Agent access never widens from a remote edit until the owner approves it. A held record
    // touches nothing local: no ciphertext, no policy column. It waits in held_record.
    const currentPolicy: AgentPolicy = local && !local.deleted_at ? local.agent_policy : { ...DEFAULT_AGENT_POLICY };
    if (this.widening.widens(currentPolicy, plaintext.agentPolicy)) {
      await this.remember(client, userId, record, revision, record);
      await this.audit(client, userId, 'cloud_sync_policy_held', local ? record.id : null);
      return { conflictCopy };
    }
    if (local) {
      revision = num(await this.repos.items.replaceFromCloud(
        client, userId, record.id, plaintext.type, record.item!.ciphertext, record.item!.encryptedItemKey, plaintext.agentPolicy,
      ));
      await this.audit(client, userId, 'cloud_sync_item_updated', record.id);
    } else {
      revision = num(await this.repos.items.insertFromCloud(
        client, userId, record.id, plaintext.type, record.item!.ciphertext, record.item!.encryptedItemKey, plaintext.agentPolicy,
      ));
      await this.audit(client, userId, 'cloud_sync_item_created', record.id);
    }
    await this.remember(client, userId, record, revision);
    return { conflictCopy };
  }

  private remember(client: pg.PoolClient, userId: string, record: Pick<SyncRecord, 'id' | 'generation' | 'deleted' | 'mac'>, localRevision: number | null, held: SyncRecord | null = null) {
    return this.repos.records.remember(client, userId, record, localRevision, held);
  }

  private audit(client: pg.PoolClient, userId: string, action: SyncAuditAction, itemId: string | null) {
    return this.repos.audit.record(client, userId, action, itemId);
  }

  /** Items whose pulled change would widen agent access and is waiting for the owner. */
  heldList(): Promise<HeldSummary[]> {
    return this.heldWork((client, held, ctx) => held.list(client, ctx));
  }

  /** Apply the held Cloud version of one item. */
  async heldApprove(recordId: string): Promise<{ ok: true }> {
    await this.heldWork((client, held, ctx) => held.approve(client, ctx, recordId));
    return { ok: true };
  }

  /** Discard the held Cloud version of one item; the local version is kept and pushed on the next commit. */
  async heldReject(recordId: string): Promise<{ ok: true }> {
    await this.heldWork((client, held, ctx) => held.reject(client, ctx, recordId));
    return { ok: true };
  }

  private heldWork<T>(work: (client: Queryable, held: HeldRecordService, ctx: { userId: string; userKey: Uint8Array; vaultId: string }) => Promise<T>): Promise<T> {
    return this.exclusive(async() => {
      await ensureSyncSchema(this.db);
      const envelope = await this.env();
      return this.authority.withUnlockedUserKey(async({ userId, userKey, assertCurrent }) => {
        const state = await this.state(userId);
        if (!state) throw new CloudSyncError('sync_not_configured', 409, 'Cloud sync is not turned on');
        const result = await this.transaction(async client => {
          const out = await work(client, new HeldRecordService(envelope), { userId, userKey, vaultId: state.vault_id });
          assertCurrent();
          return out;
        });
        this.stateVersion += 1;
        return result;
      });
    });
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
        if (op === 'rewrap') return this.prepareRewrap(envelope, userId, userKey, state, deviceId);
        const method = op === 'delete' ? 'DELETE' : 'POST';
        const path = op === 'delete' ? `/cloud-vault-sync/vaults/${ state.vault_id }?deviceId=${ encodeURIComponent(deviceId) }`
          : `/cloud-vault-sync/vaults/${ state.vault_id }/${ op }?deviceId=${ encodeURIComponent(deviceId) }`;
        return this.stash(userId, op, method, path, Buffer.alloc(0), state.vault_id, async(_res, client) => {
          if (op === 'delete') {
            await this.repos.records.removeAll(client, userId);
            await this.repos.state.remove(client, userId);
          }
        });
      });
    });
  }

  private async prepareCreate(envelope: DomainVaultSyncCodec, userId: string, userKey: Uint8Array, state: StateRow | null, deviceId: string, replace: boolean) {
    const account = await this.account(userId);
    if (!account) throw new CloudSyncError('vault_missing', 409, 'The local vault account is missing');
    const vaultId = replace || !state ? randomUUID() : state.vault_id;
    let fields;
    const recovery = BUNDLE_V2_UPLOAD_ENABLED ? await this.recovery(userId) : null;
    try {
      fields = bundleFields(account, { vaultId, epoch: 1, bundleGeneration: 1 }, recovery);
    } catch (error) {
      throw new CloudSyncError('password_kdf_missing', 409, (error as Error).message);
    }
    const bundle = envelope.buildBundle(fields, userKey);
    const items = await this.repos.items.listLive(this.db, userId);
    const records = items.map(row => envelope.buildRecord(itemRecordFields(row, { vaultId, generation: 1 }), userKey));
    const head = envelope.buildHead({ vaultId, scope: 'personal', seq: 1, records, prevHeadMac: '' }, userKey);
    const body = Buffer.from(JSON.stringify({ bundle, scope: 'personal', records, head }));
    const serverOp: ServerOp = replace ? 'replace' : 'create';
    const revisions = new Map(items.map(row => [row.id, num(row.revision)]));
    return this.stash(userId, serverOp, 'PUT', `/cloud-vault-sync/vaults/${ vaultId }?op=${ serverOp }&deviceId=${ encodeURIComponent(deviceId) }`, body, vaultId, async(_res, client) => {
      await this.repos.records.removeAll(client, userId);
      await this.repos.state.saveCreated(client, userId, vaultId, head.mac, wrapFingerprint(account, recovery));
      for (const record of records) await this.remember(client, userId, record, revisions.get(record.id) ?? null);
    });
  }

  /** Password or KDF changed on this Desktop: re-upload only the bundle, CAS on bundleGeneration. */
  private async prepareRewrap(envelope: DomainVaultSyncCodec, userId: string, userKey: Uint8Array, state: StateRow, deviceId: string) {
    const account = await this.account(userId);
    if (!account) throw new CloudSyncError('vault_missing', 409, 'The local vault account is missing');
    let fields;
    const recovery = BUNDLE_V2_UPLOAD_ENABLED ? await this.recovery(userId) : null;
    try {
      fields = bundleFields(account, { vaultId: state.vault_id, epoch: num(state.epoch), bundleGeneration: num(state.bundle_generation) + 1 }, recovery);
    } catch (error) {
      throw new CloudSyncError('password_kdf_missing', 409, (error as Error).message);
    }
    const bundle = envelope.buildBundle(fields, userKey);
    const body = Buffer.from(JSON.stringify({ bundle, expectedBundleGeneration: num(state.bundle_generation) }));
    const fingerprint = wrapFingerprint(account, recovery);
    return this.stash(userId, 'rewrap', 'PUT', `/cloud-vault-sync/vaults/${ state.vault_id }?op=rewrap&deviceId=${ encodeURIComponent(deviceId) }`, body, state.vault_id, async(_res, client) => {
      await this.repos.state.recordRewrap(client, userId, bundle.bundleGeneration, fingerprint);
    });
  }

  private async prepareCommit(envelope: DomainVaultSyncCodec, userId: string, userKey: Uint8Array, state: StateRow, deviceId: string) {
    const known = await this.known(userId);
    const rows = await this.repos.items.listForCommit(this.db, userId);
    const writes: Array<{ id: string; baseGeneration: number; record: SyncRecord }> = [];
    const revisions = new Map<string, number>();
    let bytes = 0;
    for (const row of rows) {
      if (this.commitBudget.isFull(writes.length, bytes)) break;
      const prior = known.get(row.id);
      // A held id waits for the owner: neither the local version nor its delete goes up meanwhile.
      if (prior?.policy_review_pending) continue;
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
      await this.repos.state.advancePushedHead(client, userId, head.seq, head.mac);
      for (const write of writes) await this.remember(client, userId, write.record, revisions.get(write.id) ?? null);
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
        await this.repos.state.recordError(this.db, userId, error).catch(() => undefined);
        return { ok: false, status: res.status, error, detail: res.status === 409 ? res.body : undefined };
      });
    });
  }

  /** Forget local sync bookkeeping (after the Cloud copy is gone). Local items are untouched. */
  forget(): Promise<void> {
    return this.exclusive(async() => {
      await ensureSyncSchema(this.db);
      await this.authority.withUnlockedUserKey(async({ userId }) => {
        await this.repos.records.removeAll(this.db, userId);
        await this.repos.state.remove(this.db, userId);
      });
      this.stateVersion += 1;
    });
  }
}
