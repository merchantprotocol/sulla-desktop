// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes, timingSafeEqual } from 'node:crypto';

import { CapabilityKeyCandidates, type SigningKey } from './CapabilityKeyCandidates.js';

import { decrypt, encrypt, type Envelope } from './crypto.js';
import { TransactionRunner } from './FilesTransaction.js';
import { CollectionKeyRepository } from './Repositories/CollectionKeyRepository.js';
import { FilesKeyStateRepository } from './Repositories/FilesKeyStateRepository.js';
import { LegacySigningKeySelector } from './Services/LegacySigningKeySelector.js';
import { UNSCOPED_PROFILE_ID } from './ProfileIdentity.js';

import type pg from 'pg';

const CONTEXT = 'sulla:files:master-check:v1';
const CHECK = Buffer.from('sulla-files-keychain-master-v1');
export interface CollectionKeys { data: Uint8Array; dedup: Uint8Array }
type Queryable = Pick<pg.Pool, 'query'>;

export class FilesMasterKeyRejectedError extends Error {
  readonly code = 'FILES_MASTER_KEY_REJECTED';

  constructor(cause?:unknown) {
    super('Files master key was rejected', { cause });
  }
}

/** Plaintext exists only in this process. Persisted envelopes require the Desktop keychain key. */
export class FilesKeyring {
  private master?:  Buffer;
  private epoch = 0;
  private pending?: Promise<void>;
  /** Collection keys are cached per Cloud profile so one account's sign-out never drops another's. */
  private readonly cache = new Map<string, CollectionKeys>();
  private readonly profileEpochs = new Map<string, number>();
  constructor(
    private readonly db:pg.Pool,
    private readonly collectionKeys = new CollectionKeyRepository(db),
    private readonly keyState = new FilesKeyStateRepository(db),
    private readonly transactions = new TransactionRunner(db),
    /** Chooses between the current and pre-#2369 signing key; absent, the current key is always used. */
    private readonly legacyKeys?:LegacySigningKeySelector,
    /** Active Cloud profile id; the cache is keyed by it. Absent, every caller shares one profile. */
    private readonly profileOf:()=>string=()=>UNSCOPED_PROFILE_ID,
  ) {}
  get unlocked():boolean { return Boolean(this.master) }

  async unlock(master:Buffer, legacySigningKey:SigningKey | CapabilityKeyCandidates):Promise<void> {
    return this.unlockInternal(master, CapabilityKeyCandidates.of(legacySigningKey));
  }

  private async unlockInternal(master:Buffer, legacySigningKey:CapabilityKeyCandidates):Promise<void> {
    if (master.length !== 32) throw new Error('Invalid Files master key');
    const epoch = this.epoch;
    if (this.pending) await this.pending;
    if (epoch !== this.epoch) throw new Error('Files was locked during unlock');
    if (this.master) {
      if (!timingSafeEqual(master, this.master)) throw new Error('Files already unlocked with another key');
      return;
    }
    const copy = Buffer.from(master);
    this.pending = this.initialize(copy, legacySigningKey, epoch).finally(() => copy.fill(0));
    try { await this.pending } finally { this.pending = undefined }
  }

  private async initialize(master:Buffer, legacySigningKeys:CapabilityKeyCandidates, epoch:number):Promise<void> {
    try {
      await this.transactions.run('files-keyring-unlock', async client => {
        await this.keyState.lockState(client);
        const verifier = await this.keyState.findVerifier(client);
        if (verifier) {
          let check:Uint8Array;
          try { check = await decrypt(verifier, master, CONTEXT) } catch (error) { throw new FilesMasterKeyRejectedError(error) }
          try { if (!Buffer.from(check).equals(CHECK)) throw new FilesMasterKeyRejectedError() } finally { check.fill(0) }
          // Never overwrite damaged wrapped keys or silently derive replacements.
          const rows = await this.collectionKeys.publishedWrappedKeys(client);
          for (const row of rows) {
            const keys = await this.unwrap(row.collection_id, row.data_key, row.dedup_key, master);
            keys.data.fill(0); keys.dedup.fill(0);
          }
        } else {
          // Only migration-classified native rows are known to have used the
          // historical signing-derived scheme. Ambiguous/external rows remain
          // unkeyed until the separate secure import flow proves their origin.
          const rows = await this.collectionKeys.lockNativeCollectionsForLegacyMigration(client);
          for (const row of rows) {
            // The legacy master.key wrapped metadata only; content used these deterministic keys.
            const legacySigningKey = this.legacyKeys ? await this.legacyKeys.select(client, row.id, legacySigningKeys) : legacySigningKeys.current;
            const data = LegacySigningKeySelector.dataKey(legacySigningKey, row.id);
            const dedup = LegacySigningKeySelector.dedupKey(legacySigningKey, row.id);
            try {
              const wrappedData = await encrypt(data, master, `sulla:files:data-key:v1:${ row.id }`);
              const wrappedDedup = await encrypt(dedup, master, `sulla:files:dedup-key:v1:${ row.id }`);
              if (!row.data_key && !row.dedup_key) {
                await this.collectionKeys.insertLegacySigningKeys(client, row.id, wrappedData, wrappedDedup);
              } else {
                throw new Error('Existing Files key state cannot be migrated automatically');
              }
            } finally { data.fill(0); dedup.fill(0) }
          }
          await this.keyState.insertVerifier(client, await encrypt(CHECK, master, CONTEXT));
        }
        if (epoch !== this.epoch) throw new Error('Files was locked during unlock');
      });
      if (epoch !== this.epoch) throw new Error('Files was locked during unlock');
      this.master = Buffer.from(master);
    } catch (error) {
      if (error instanceof FilesMasterKeyRejectedError) throw error;
      throw new Error('Files key unlock failed; existing data was preserved', { cause: error });
    }
  }

  private async unwrap(id:string, data:Envelope, dedup:Envelope, master:Buffer):Promise<CollectionKeys> {
    const dataKey = await decrypt(data, master, `sulla:files:data-key:v1:${ id }`);
    try {
      const dedupKey = await decrypt(dedup, master, `sulla:files:dedup-key:v1:${ id }`);
      if (dataKey.length !== 32 || dedupKey.length !== 32) { dedupKey.fill(0); throw new Error('Invalid collection key') }
      return { data: dataKey, dedup: dedupKey };
    } catch (error) { dataKey.fill(0); throw error }
  }

  async keys(id:string, queryable:Queryable = this.db):Promise<CollectionKeys> {
    if (!this.master) throw Object.assign(new Error('Files is locked'), { status: 503 });
    const profile = this.profileOf(); const cacheKey = this.cacheKey(profile, id);
    const cached = this.cache.get(cacheKey); if (cached) return cached;
    const epoch = this.epoch; const profileEpoch = this.profileEpoch(profile); const master = Buffer.from(this.master);
    try {
      const row = await this.collectionKeys.findWrappedKeys(id, queryable);
      if (!row) throw new Error('Collection key unavailable; secure key exchange is required');
      const keys = await this.unwrap(id, row.data_key, row.dedup_key, master);
      if (epoch !== this.epoch) { keys.data.fill(0); keys.dedup.fill(0); throw new Error('Files was locked during key access') }
      if (profileEpoch !== this.profileEpoch(profile)) { keys.data.fill(0); keys.dedup.fill(0); throw new Error('Files profile was invalidated during key access') }
      const concurrent = this.cache.get(cacheKey);
      if (concurrent) { keys.data.fill(0); keys.dedup.fill(0); return concurrent }
      this.cache.set(cacheKey, keys); return keys;
    } finally { master.fill(0) }
  }

  /** Resolve directly from persisted wrapped keys, deliberately bypassing every in-memory cache. */
  async keysFresh(id:string):Promise<CollectionKeys> {
    if (!this.master) throw Object.assign(new Error('Files is locked'), { status:503 });
    const epoch = this.epoch; const profile = this.profileOf(); const profileEpoch = this.profileEpoch(profile);
    const master = Buffer.from(this.master);
    try {
      const row = await this.collectionKeys.findWrappedKeys(id, this.db);
      if (!row) throw Object.assign(new Error('Collection key unavailable'), { status:503, code:'collection_key_unavailable' });
      const keys = await this.unwrap(id, row.data_key, row.dedup_key, master);
      if (epoch !== this.epoch || profileEpoch !== this.profileEpoch(profile)) { keys.data.fill(0); keys.dedup.fill(0); throw new Error('Files key scope changed during resolution') }
      return keys;
    } finally { master.fill(0) }
  }

  invalidate(id:string):void {
    const cacheKey = this.cacheKey(this.profileOf(), id); const keys = this.cache.get(cacheKey);
    if (!keys) return;
    keys.data.fill(0); keys.dedup.fill(0); this.cache.delete(cacheKey);
  }

  async create(id:string, client:pg.PoolClient):Promise<{ data: Envelope; dedup: Envelope }> {
    if (!this.master) throw new Error('Files is locked');
    const epoch = this.epoch; const master = Buffer.from(this.master);
    const data = randomBytes(32); const dedup = randomBytes(32);
    try {
      const wrapped = { data: await encrypt(data, master, `sulla:files:data-key:v1:${ id }`), dedup: await encrypt(dedup, master, `sulla:files:dedup-key:v1:${ id }`) };
      if (epoch !== this.epoch) throw new Error('Files was locked during key creation');
      await this.collectionKeys.insertRandomKeys(client, id, wrapped.data, wrapped.dedup);
      if (epoch !== this.epoch) throw new Error('Files was locked during key creation');
      return wrapped;
    } finally { master.fill(0); data.fill(0); dedup.fill(0) }
  }

  /** Short-lived copies for enrollment into the opaque Vault custody bundle. */
  async copyKeys(id:string):Promise<CollectionKeys> {
    const keys = await this.keys(id);
    return { data: Buffer.from(keys.data), dedup: Buffer.from(keys.dedup) };
  }

  /**
   * Replace a lost device master only after every random collection key has
   * been recovered and context-verified by the custody authority.
   */
  async installRecoveredMaster(master:Buffer, recovered:ReadonlyMap<string, CollectionKeys>):Promise<void> {
    if (master.length !== 32) throw new Error('Invalid Files master key');
    if (this.master || this.pending) throw new Error('Files must be locked before device recovery');
    const epoch = this.epoch;
    const copy = Buffer.from(master);
    this.pending = this.replaceMaster(copy, recovered, epoch).finally(() => copy.fill(0));
    try { await this.pending } finally { this.pending = undefined }
  }

  private async replaceMaster(master:Buffer, recovered:ReadonlyMap<string, CollectionKeys>, epoch:number):Promise<void> {
    let committed = false;
    try {
      await this.transactions.run('files-keyring-device-recovery', async client => {
        await this.keyState.lockStateAndCollectionKeys(client);
        const rows = await this.collectionKeys.publishedKeyOrigins(client);
        if (rows.length === 0 || rows.length !== recovered.size) throw new Error('Incomplete Files recovery bundle set');
        for (const row of rows) {
          if (row.key_origin !== 'random') throw new Error('Legacy Files keys require the separate secure import flow');
          const keys = recovered.get(row.collection_id);
          if (keys?.data.length !== 32 || keys.dedup.length !== 32) throw new Error('Invalid recovered collection keys');
          await this.collectionKeys.replaceWrappedKeys(
            client, row.collection_id, await encrypt(keys.data, master, `sulla:files:data-key:v1:${ row.collection_id }`),
            await encrypt(keys.dedup, master, `sulla:files:dedup-key:v1:${ row.collection_id }`),
          );
        }
        await this.keyState.upsertVerifier(client, await encrypt(CHECK, master, CONTEXT));
        if (epoch !== this.epoch) throw new Error('Files was locked during device recovery');
      });
      committed = true;
      if (epoch !== this.epoch) throw new Error('Files device recovery committed while the service was locking');
      this.master = Buffer.from(master);
      const profile = this.profileOf();
      for (const [id, keys] of recovered) this.cache.set(this.cacheKey(profile, id), { data: Buffer.from(keys.data), dedup: Buffer.from(keys.dedup) });
    } catch (error) {
      if (committed) throw new Error('Files device recovery committed but remained locked; retry unlock with the replacement master', { cause: error });
      throw new Error('Files device recovery failed; existing key envelopes were preserved', { cause: error });
    }
  }

  async requireLegacySync(id:string):Promise<void> {
    if (!this.master) throw new Error('Files is locked');
    if (await this.collectionKeys.findKeyOrigin(id) !== 'legacy-signing-v1') throw new Error('Files sync requires secure collection-key exchange for this collection; existing local data is preserved');
  }

  close():void {
    this.epoch++;
    this.master?.fill(0); this.master = undefined;
    for (const keys of this.cache.values()) { keys.data.fill(0); keys.dedup.fill(0) }
    this.cache.clear();
  }

  /** Zeroizes and forgets one profile's cached collection keys; other profiles are untouched. */
  invalidateProfile(profileId:string):void {
    this.profileEpochs.set(profileId, this.profileEpoch(profileId) + 1);
    const prefix = `${ profileId }\u0000`;
    for (const [cacheKey, keys] of [...this.cache]) {
      if (!cacheKey.startsWith(prefix)) continue;
      keys.data.fill(0); keys.dedup.fill(0);
      this.cache.delete(cacheKey);
    }
  }

  private profileEpoch(profileId:string):number { return this.profileEpochs.get(profileId) ?? 0 }

  private cacheKey(profileId:string, id:string):string { return `${ profileId }\u0000${ id }` }
}
