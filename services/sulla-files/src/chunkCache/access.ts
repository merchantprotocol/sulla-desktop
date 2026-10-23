import type pg from 'pg';

export class ChunkAccessTracker {
  private readonly pending = new Map<string, { collectionId:string; chunkId:string }>();
  private timer?:NodeJS.Timeout;
  constructor(private readonly db:Pick<pg.Pool, 'query'>, private readonly flushMs = 1_000) {}
  record(collectionId:string, chunkId:string):void {
    this.pending.set(`${collectionId}:${chunkId}`, { collectionId, chunkId });
    this.timer ??= setTimeout(() => void this.flush().catch(() => undefined), this.flushMs);
    this.timer.unref();
  }
  async flush():Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const entries = [...this.pending.values()]; this.pending.clear();
    if (!entries.length) return;
    await this.db.query(`INSERT INTO files_chunk_cache(collection_id,chunk_id,state,last_read_at)
      SELECT collection_id::uuid,chunk_id,'resident',NOW() FROM jsonb_to_recordset($1::jsonb) AS x(collection_id text,chunk_id text)
      ON CONFLICT(collection_id,chunk_id) DO UPDATE SET last_read_at=EXCLUDED.last_read_at`, [JSON.stringify(entries.map(({ collectionId:collection_id, chunkId:chunk_id }) => ({ collection_id, chunk_id })))]);
  }
  stop():Promise<void> { return this.flush() }
}
