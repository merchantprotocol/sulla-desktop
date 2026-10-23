import { chunkId, encryptChunk } from '../crypto.js';
import type { FilesKeyring } from '../keyring.js';
import type { Store } from '../store.js';
import type { CloudChunkSource } from './types.js';
import type pg from 'pg';

export class ChunkHydrator {
  private readonly flights = new Map<string, Promise<Buffer>>();
  constructor(private readonly db:Pick<pg.Pool, 'query'>, private readonly store:Store, private readonly keyring:FilesKeyring, private readonly source:CloudChunkSource) {}
  hydrate(collectionId:string, id:string):Promise<Buffer> {
    const flightKey = `${collectionId}:${id}`;
    const current = this.flights.get(flightKey); if (current) return current;
    const flight = this.run(collectionId, id).finally(() => this.flights.delete(flightKey));
    this.flights.set(flightKey, flight); return flight;
  }
  private async run(collectionId:string, id:string):Promise<Buffer> {
    const row = (await this.db.query("SELECT state FROM files_chunk_cache WHERE collection_id=$1 AND chunk_id=$2", [collectionId, id])).rows[0];
    if (row?.state !== 'evicted') throw Object.assign(new Error('Local chunk is unavailable'), { code: 'ENOENT' });
    let plain:Buffer;
    try { plain = await this.source.fetchPlain(collectionId, id) } catch (error:any) {
      if (error?.code === 'FILE_OFFLINE') throw error;
      throw error;
    }
    const keys = await this.keyring.keys(collectionId);
    try {
      if (chunkId(plain, keys.dedup) !== id) throw Object.assign(new Error('Hydrated chunk identity mismatch'), { code: 'FILE_INTEGRITY' });
      const encrypted = await encryptChunk(plain, keys.data, id);
      await this.store.put(collectionId, id, encrypted);
      await this.db.query("UPDATE files_chunk_cache SET state='resident',stored_bytes=$3,last_read_at=NOW(),updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2", [collectionId, id, encrypted.byteLength]);
      return encrypted;
    } finally { plain.fill(0) }
  }
}
