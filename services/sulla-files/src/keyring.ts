import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { decrypt, encrypt, type Envelope } from './crypto.js';

import type pg from 'pg';

const CONTEXT = 'sulla:files:master-check:v1';
const CHECK = Buffer.from('sulla-files-keychain-master-v1');
export interface CollectionKeys { data: Uint8Array; dedup: Uint8Array }

/** Plaintext exists only in this process. Persisted envelopes require the Desktop keychain key. */
export class FilesKeyring {
  private master?: Buffer;
  private epoch = 0;
  private pending?: Promise<void>;
  private readonly cache = new Map<string, CollectionKeys>();
  constructor(private readonly db:pg.Pool) {}
  get unlocked():boolean { return Boolean(this.master) }

  async unlock(master:Buffer, legacySigningKey:string | Buffer):Promise<void> {
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

  private async initialize(master:Buffer, legacySigningKey:string | Buffer, epoch:number):Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE files_key_state IN EXCLUSIVE MODE');
      const state = (await client.query('SELECT verifier FROM files_key_state WHERE id=TRUE')).rows[0];
      if (state) {
        const check = await decrypt(state.verifier, master, CONTEXT);
        try { if (!Buffer.from(check).equals(CHECK)) throw new Error('Invalid Files master key') } finally { check.fill(0) }
        // Never overwrite damaged wrapped keys or silently derive replacements.
        const rows = (await client.query('SELECT collection_id,data_key,dedup_key FROM files_collection_keys')).rows;
        for (const row of rows) {
          const keys = await this.unwrap(row.collection_id, row.data_key, row.dedup_key, master);
          keys.data.fill(0); keys.dedup.fill(0);
        }
      } else {
        const rows = (await client.query('SELECT id FROM collections')).rows;
        for (const row of rows) {
          // The legacy master.key wrapped metadata only; content used these deterministic keys.
          const data = createHmac('sha256', legacySigningKey).update(`sulla:files:data-key:v1:${ row.id }`).digest();
          const dedup = createHmac('sha256', legacySigningKey).update(`sulla:files:dedup-key:v1:${ row.id }`).digest();
          try {
            await client.query("INSERT INTO files_collection_keys(collection_id,data_key,dedup_key,key_origin) VALUES($1,$2,$3,'legacy-signing-v1')", [row.id, await encrypt(data, master, `sulla:files:data-key:v1:${ row.id }`), await encrypt(dedup, master, `sulla:files:dedup-key:v1:${ row.id }`)]);
          } finally { data.fill(0); dedup.fill(0) }
        }
        await client.query('INSERT INTO files_key_state(id,verifier) VALUES(TRUE,$1)', [await encrypt(CHECK, master, CONTEXT)]);
      }
      if (epoch !== this.epoch) throw new Error('Files was locked during unlock');
      await client.query('COMMIT');
      if (epoch !== this.epoch) throw new Error('Files was locked during unlock');
      this.master = Buffer.from(master);
    } catch { await client.query('ROLLBACK'); throw new Error('Files key unlock failed; existing data was preserved') } finally { client.release() }
  }

  private async unwrap(id:string, data:Envelope, dedup:Envelope, master:Buffer):Promise<CollectionKeys> {
    const dataKey = await decrypt(data, master, `sulla:files:data-key:v1:${ id }`);
    try {
      const dedupKey = await decrypt(dedup, master, `sulla:files:dedup-key:v1:${ id }`);
      if (dataKey.length !== 32 || dedupKey.length !== 32) { dedupKey.fill(0); throw new Error('Invalid collection key') }
      return { data: dataKey, dedup: dedupKey };
    } catch (error) { dataKey.fill(0); throw error }
  }

  async keys(id:string):Promise<CollectionKeys> {
    if (!this.master) throw Object.assign(new Error('Files is locked'), { status: 503 });
    const cached = this.cache.get(id); if (cached) return cached;
    const epoch = this.epoch; const master = Buffer.from(this.master);
    try {
      const row = (await this.db.query('SELECT data_key,dedup_key FROM files_collection_keys WHERE collection_id=$1', [id])).rows[0];
      if (!row) throw new Error('Collection key unavailable; secure key exchange is required');
      const keys = await this.unwrap(id, row.data_key, row.dedup_key, master);
      if (epoch !== this.epoch) { keys.data.fill(0); keys.dedup.fill(0); throw new Error('Files was locked during key access') }
      const concurrent = this.cache.get(id);
      if (concurrent) { keys.data.fill(0); keys.dedup.fill(0); return concurrent }
      this.cache.set(id, keys); return keys;
    } finally { master.fill(0) }
  }

  async create(id:string, client:pg.PoolClient):Promise<{ data:Envelope; dedup:Envelope }> {
    if (!this.master) throw new Error('Files is locked');
    const epoch = this.epoch; const master = Buffer.from(this.master);
    const data = randomBytes(32); const dedup = randomBytes(32);
    try {
      const wrapped = { data: await encrypt(data, master, `sulla:files:data-key:v1:${ id }`), dedup: await encrypt(dedup, master, `sulla:files:dedup-key:v1:${ id }`) };
      if (epoch !== this.epoch) throw new Error('Files was locked during key creation');
      await client.query('INSERT INTO files_collection_keys(collection_id,data_key,dedup_key) VALUES($1,$2,$3)', [id, wrapped.data, wrapped.dedup]);
      if (epoch !== this.epoch) throw new Error('Files was locked during key creation');
      return wrapped;
    } finally { master.fill(0); data.fill(0); dedup.fill(0) }
  }

  async requireLegacySync(id:string):Promise<void> {
    if (!this.master) throw new Error('Files is locked');
    const row = (await this.db.query('SELECT key_origin FROM files_collection_keys WHERE collection_id=$1', [id])).rows[0];
    if (row?.key_origin !== 'legacy-signing-v1') throw new Error('Files sync requires secure collection-key exchange for this collection; existing local data is preserved');
  }

  close():void {
    this.epoch++;
    this.master?.fill(0); this.master = undefined;
    for (const keys of this.cache.values()) { keys.data.fill(0); keys.dedup.fill(0) }
    this.cache.clear();
  }
}

/** Existing standalone server protocol. Never used by Desktop or as an unlock fallback. */
export class LegacyServerKeyring extends FilesKeyring {
  constructor(db:pg.Pool, private readonly signingKey:string | Buffer) { super(db) }
  override get unlocked():boolean { return true }
  override async keys(id:string):Promise<CollectionKeys> {
    return {
      data: createHmac('sha256', this.signingKey).update(`sulla:files:data-key:v1:${ id }`).digest(),
      dedup: createHmac('sha256', this.signingKey).update(`sulla:files:dedup-key:v1:${ id }`).digest(),
    };
  }
  override async unlock():Promise<void> { throw new Error('Desktop keychain bootstrap is unavailable in server mode') }
}
