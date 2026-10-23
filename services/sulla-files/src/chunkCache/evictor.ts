import { stat } from 'node:fs/promises';
import { requiredEvictionBytes } from './budget.js';
import type { CloudChunkSource } from './types.js';
import type { Store } from '../store.js';
import type pg from 'pg';

const RECENT_READ_MS = 5 * 60 * 1_000;

export class ChunkCacheEvictor {
  private running?:Promise<number>;
  constructor(private readonly db:Pick<pg.Pool, 'query'>, private readonly store:Store, private readonly root:string, private readonly source:CloudChunkSource) {}
  run(requiredBytes?:number):Promise<number> { return this.running ??= this.evict(requiredBytes).finally(() => { this.running = undefined }); }
  private async evict(requiredBytes?:number):Promise<number> {
    const resident = Number((await this.db.query("SELECT COALESCE(SUM(stored_bytes),0) bytes FROM files_chunk_cache WHERE state='resident'")).rows[0]?.bytes ?? 0);
    let needed:number;
    try { needed = requiredBytes ?? await requiredEvictionBytes(this.root, resident) } catch { return 0 }
    if (needed <= 0) return 0;
    const rows = (await this.db.query(`SELECT cc.collection_id::text,cc.chunk_id,cc.stored_bytes,cc.last_read_at
      FROM files_chunk_cache cc
      WHERE cc.state='resident' AND (cc.last_read_at IS NULL OR cc.last_read_at < NOW()-INTERVAL '5 minutes')
      AND NOT EXISTS(SELECT 1 FROM files_protected_chunks p WHERE p.collection_id=cc.collection_id AND p.chunk_id=cc.chunk_id)
      ORDER BY cc.last_read_at ASC NULLS FIRST LIMIT 1000`)).rows;
    let freed = 0;
    for (const row of rows) {
      if (freed >= needed) break;
      const collectionId = String(row.collection_id), id = String(row.chunk_id);
      const copy = await this.source.verifiedCopy(collectionId, id);
      if (!copy || !Number.isFinite(new Date(copy.verifiedAt).getTime())) continue;
      // Pinning is owned by cloud sync. Missing schema or row is fail-closed.
      try {
        const collection = (await this.db.query('SELECT keep_on_computer FROM collections WHERE id=$1', [collectionId])).rows[0];
        if (!collection || collection.keep_on_computer) continue;
      } catch { continue }
      if (!await this.source.reverify(collectionId, id)) continue;
      const [protectedNow, pinNow] = await Promise.all([
        this.db.query('SELECT 1 FROM files_protected_chunks WHERE collection_id=$1 AND chunk_id=$2', [collectionId, id]),
        this.db.query('SELECT keep_on_computer FROM collections WHERE id=$1', [collectionId]),
      ]);
      if (protectedNow.rowCount || !pinNow.rows[0] || pinNow.rows[0].keep_on_computer) continue;
      const recent = (await this.db.query('SELECT last_read_at FROM files_chunk_cache WHERE collection_id=$1 AND chunk_id=$2', [collectionId, id])).rows[0]?.last_read_at;
      if (recent && Date.now() - new Date(recent).getTime() < RECENT_READ_MS) continue;
      const transition = await this.db.query("UPDATE files_chunk_cache SET state='evicting',updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2 AND state='resident' RETURNING stored_bytes", [collectionId, id]);
      if (!transition.rowCount) continue;
      try {
        // Store.path constrains deletion to the configured encrypted chunk root.
        const info = await stat(this.store.path(collectionId, id));
        await this.store.delete(collectionId, id);
        await this.db.query("UPDATE files_chunk_cache SET state='evicted',stored_bytes=0,evicted_at=NOW(),updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2 AND state='evicting'", [collectionId, id]);
        freed += info.size;
      } catch (error:any) {
        if (error?.code === 'ENOENT') await this.db.query("UPDATE files_chunk_cache SET state='evicted',stored_bytes=0,evicted_at=NOW(),updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2", [collectionId, id]);
        else { await this.db.query("UPDATE files_chunk_cache SET state='resident',updated_at=NOW() WHERE collection_id=$1 AND chunk_id=$2", [collectionId, id]); throw error }
      }
    }
    return freed;
  }
}
