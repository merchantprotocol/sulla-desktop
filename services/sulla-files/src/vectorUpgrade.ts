import type pg from 'pg';

import { vectorLiteral } from './potionEmbedder.js';

/**
 * One-time background move of Files semantic search from JSONB embeddings
 * (scored in Node) onto pgvector (scored in SQL through an HNSW index).
 *
 *   1. prepare   CREATE EXTENSION vector; add file_search_chunks.embedding vector(512).
 *                No pgvector (stock image, offline fallback) => 'unavailable' and
 *                Files keeps working with full-text search only.
 *   2. backfill  Copy embedding_json into embedding in small keyset batches,
 *                pausing between them so ingest is never starved. Resumable:
 *                only rows WHERE embedding IS NULL are touched.
 *   3. repair    Any chunk still without an embedding (bad or missing JSON, or
 *                written while pgvector was unavailable) is re-embedded from its
 *                stored content with the same local model.
 *   4. verify    Every chunk has an embedding, and a random sample of rows has
 *                cosine >= 0.9999 between the JSON and the vector form.
 *   5. reclaim   OPT-IN (reclaim:true / SULLA_FILES_RECLAIM_JSON_EMBEDDINGS=1),
 *                and only when verification passed: drop embedding_json and
 *                VACUUM FULL the table. Runs BEFORE the HNSW build so the
 *                rewrite does not also rebuild the HNSW index under its lock.
 *                Default: embedding_json is left in place (unused by search).
 *   6. index     CREATE INDEX CONCURRENTLY ... USING hnsw. An INVALID leftover
 *                from an interrupted build is dropped and rebuilt.
 *
 * Every step is idempotent, so a crash or restart at any point resumes.
 */
export type VectorSearchState = 'unavailable' | 'backfilling' | 'indexing' | 'ready';

export interface VectorSearchStatus {
  vectorSearch:    VectorSearchState;
  phase:           string;
  chunks?:         number;
  embedded?:       number;
  jsonColumn?:     boolean;
  indexValid?:     boolean;
  reclaimedBytes?: number;
  error?:          string;
}

export interface VectorEmbedder { embed(text:string):Float32Array }

export interface VectorUpgradeOptions {
  batchSize?:          number;
  pauseMs?:            number;
  progressMs?:         number;
  spotChecks?:         number;
  maintenanceWorkMem?: string;
  /** Drop embedding_json + VACUUM FULL after verification. Opt-in; default off. */
  reclaim?:            boolean;
  log?:                (line:string) => void;
}

export const VECTOR_INDEX = 'idx_file_search_chunks_embedding_hnsw';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const DIM = 512;

const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
const message = (error:unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];

export function parseVectorText(text:string):number[] {
  return text.replace(/^\[|\]$/g, '').split(',').map(Number);
}

export function cosineOf(a:ArrayLike<number>, b:ArrayLike<number>):number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / Math.sqrt(na * nb) : (na === nb ? 1 : 0);
}

export class VectorSearchUpgrade {
  private state:VectorSearchState = 'unavailable';
  private phase = 'not-started';
  private ready = false;
  private stopped = false;
  private running?:Promise<void>;
  private snapshot:Omit<VectorSearchStatus, 'vectorSearch' | 'phase'> = {};
  private readonly options:Required<Omit<VectorUpgradeOptions, 'log'>> & { log:(line:string) => void };

  constructor(private readonly db:pg.Pool, private readonly embedder:VectorEmbedder, options:VectorUpgradeOptions = {}) {
    this.options = {
      batchSize:          options.batchSize ?? 2_000,
      pauseMs:            options.pauseMs ?? 150,
      progressMs:         options.progressMs ?? 30_000,
      spotChecks:         options.spotChecks ?? 200,
      maintenanceWorkMem: options.maintenanceWorkMem ?? '1GB',
      // Dropping embedding_json is destructive, so it is opt-in: pass
      // reclaim:true or set SULLA_FILES_RECLAIM_JSON_EMBEDDINGS=1. Off by default.
      reclaim:            options.reclaim ?? process.env.SULLA_FILES_RECLAIM_JSON_EMBEDDINGS === '1',
      log:                options.log ?? (line => console.log(`[SullaFiles] ${ line }`)),
    };
  }

  /** True once file_search_chunks.embedding exists and pgvector works: write and query it. */
  get columnReady():boolean { return this.ready }

  status():VectorSearchStatus { return { vectorSearch: this.state, phase: this.phase, ...this.snapshot } }

  /** Starts the background upgrade once; never throws. */
  start():Promise<void> {
    this.stopped = false;
    this.running ??= this.upgrade()
      .catch(error => {
        this.snapshot.error = message(error);
        this.options.log(`vector search upgrade paused at ${ this.phase }: ${ this.snapshot.error } (resumes on next start)`);
      })
      .finally(() => { this.running = undefined });
    return this.running;
  }

  async stop():Promise<void> { this.stopped = true; await this.running?.catch(() => undefined) }

  private checkStopped():void { if (this.stopped) throw new Error('stopped') }

  async upgrade():Promise<void> {
    this.snapshot.error = undefined;
    if (!await this.prepare()) return;
    const json = await this.jsonColumnExists();
    this.snapshot.jsonColumn = json;
    this.state = 'backfilling';
    if (json) await this.backfill();
    await this.repairMissing();
    if (json) {
      const verified = await this.verify();
      if (verified && this.options.reclaim) await this.reclaim();
    }
    this.state = 'indexing';
    await this.buildIndex();
    await this.count();
    this.state = 'ready'; this.phase = 'ready';
    this.options.log(`vector search ready (${ this.snapshot.embedded }/${ this.snapshot.chunks } chunks embedded, HNSW)`);
  }

  private async count():Promise<void> {
    const counts = (await this.db.query('SELECT COUNT(*)::bigint total, COUNT(embedding)::bigint embedded FROM file_search_chunks')).rows[0];
    this.snapshot.chunks = Number(counts.total); this.snapshot.embedded = Number(counts.embedded);
  }

  private async prepare():Promise<boolean> {
    this.phase = 'prepare';
    try {
      await this.db.query('CREATE EXTENSION IF NOT EXISTS vector');
      await this.db.query("SELECT '[1]'::vector");
    } catch (error) {
      this.state = 'unavailable'; this.phase = 'unavailable'; this.ready = false;
      this.snapshot = { error: `pgvector unavailable: ${ message(error) }` };
      this.options.log('vector search unavailable (pgvector missing); semantic search falls back to full-text only');
      return false;
    }
    await this.withLockRetry(`ALTER TABLE file_search_chunks ADD COLUMN IF NOT EXISTS embedding vector(${ DIM })`);
    // A side table from an earlier design (005) is superseded by the column.
    await this.withLockRetry('DROP TABLE IF EXISTS file_search_vectors');
    await this.db.query(`CREATE TABLE IF NOT EXISTS files_vector_upgrade(
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id), json_dropped_at TIMESTAMPTZ, reclaimed_at TIMESTAMPTZ, reclaimed_bytes BIGINT)`);
    await this.db.query('INSERT INTO files_vector_upgrade(id) VALUES(TRUE) ON CONFLICT DO NOTHING');
    const marker = (await this.db.query('SELECT reclaimed_bytes FROM files_vector_upgrade')).rows[0];
    if (marker?.reclaimed_bytes != null) this.snapshot.reclaimedBytes = Number(marker.reclaimed_bytes);
    this.ready = true; this.state = 'backfilling';
    return true;
  }

  private async jsonColumnExists():Promise<boolean> {
    return Boolean((await this.db.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='file_search_chunks' AND column_name='embedding_json'`)).rowCount);
  }

  private async estimateChunks():Promise<number> {
    return Number((await this.db.query("SELECT GREATEST(reltuples,0)::bigint n FROM pg_class WHERE oid='file_search_chunks'::regclass")).rows[0]?.n ?? 0);
  }

  private async backfill():Promise<void> {
    this.phase = 'backfill';
    const estimate = await this.estimateChunks(); this.snapshot.chunks = estimate; this.snapshot.embedded = 0;
    const started = Date.now(); let lastLog = started; let cursor = ZERO_UUID; let updated = 0; let scanned = 0;
    for (;;) {
      this.checkStopped();
      let batch:{ last:string | null; scanned:number; updated:number };
      try {
        batch = (await this.db.query(`WITH batch AS (SELECT id FROM file_search_chunks WHERE id > $1 ORDER BY id LIMIT $2),
          locked AS (SELECT c.id FROM file_search_chunks c JOIN batch b ON b.id=c.id
            WHERE c.embedding IS NULL AND (CASE WHEN jsonb_typeof(c.embedding_json)='array' THEN jsonb_array_length(c.embedding_json) END)=${ DIM }
            FOR UPDATE OF c SKIP LOCKED),
          upd AS (UPDATE file_search_chunks c SET embedding=c.embedding_json::text::vector FROM locked l WHERE c.id=l.id RETURNING 1)
          SELECT (SELECT id::text FROM batch ORDER BY id DESC LIMIT 1) last, (SELECT COUNT(*) FROM batch)::int scanned, (SELECT COUNT(*) FROM upd)::int updated`,
        [cursor, this.options.batchSize])).rows[0];
      } catch (error) {
        // A malformed row fails the whole statement: skip this batch, the
        // repair pass re-embeds whatever it left without a vector.
        this.options.log(`vector backfill batch after ${ cursor } failed (${ message(error) }); repair pass will cover it`);
        const next = (await this.db.query('SELECT id::text FROM file_search_chunks WHERE id > $1 ORDER BY id OFFSET $2 LIMIT 1', [cursor, this.options.batchSize - 1])).rows[0];
        if (!next) break; cursor = next.id; continue;
      }
      if (!batch.last) break;
      cursor = batch.last; scanned += batch.scanned; updated += batch.updated;
      this.snapshot.embedded = (this.snapshot.embedded ?? 0) + batch.updated;
      if (Date.now() - lastLog >= this.options.progressMs) {
        lastLog = Date.now();
        const rate = Math.round(updated / Math.max(1, (lastLog - started) / 1000));
        this.options.log(`vector backfill: ${ scanned }/${ estimate } chunks scanned, ${ updated } converted (${ rate } rows/s)`);
      }
      if (this.options.pauseMs) await sleep(this.options.pauseMs);
    }
    const seconds = (Date.now() - started) / 1000;
    this.options.log(`vector backfill finished: ${ updated } converted of ${ scanned } chunks in ${ seconds.toFixed(1) }s`);
  }

  /** Re-embeds, from stored content, every chunk that still has no vector. */
  async repairMissing():Promise<number> {
    this.phase = 'repair';
    let repaired = 0;
    for (;;) {
      this.checkStopped();
      const rows = (await this.db.query<{ id:string; content:string }>(
        'SELECT id::text,content FROM file_search_chunks WHERE embedding IS NULL LIMIT 200')).rows;
      if (!rows.length) break;
      let changed = 0;
      for (const row of rows) {
        const result = await this.db.query('UPDATE file_search_chunks SET embedding=$2::vector WHERE id=$1 AND embedding IS NULL',
          [row.id, vectorLiteral(this.embedder.embed(row.content))]);
        changed += result.rowCount ?? 0;
      }
      repaired += changed;
      if (!changed) break;
      if (this.options.pauseMs) await sleep(this.options.pauseMs);
    }
    if (repaired) this.options.log(`vector repair: re-embedded ${ repaired } chunks from stored content`);
    return repaired;
  }

  /** Gate for dropping embedding_json. */
  async verify():Promise<boolean> {
    this.phase = 'verify';
    for (let attempt = 0; attempt < 3; attempt++) {
      const counts = (await this.db.query('SELECT COUNT(*)::bigint total, COUNT(embedding)::bigint embedded FROM file_search_chunks')).rows[0];
      this.snapshot.chunks = Number(counts.total); this.snapshot.embedded = Number(counts.embedded);
      if (counts.total === counts.embedded) break;
      if (attempt === 2) { this.options.log(`vector verify failed: ${ counts.embedded }/${ counts.total } chunks embedded; keeping embedding_json`); return false }
      await this.repairMissing();
    }
    const sample = (await this.db.query<{ v:string; j:number[] }>(`WITH ids AS (
        SELECT id FROM file_search_chunks WHERE embedding IS NOT NULL
          AND (CASE WHEN jsonb_typeof(embedding_json)='array' THEN jsonb_array_length(embedding_json) END)=${ DIM }
        ORDER BY random() LIMIT $1)
      SELECT c.embedding::text v, c.embedding_json j FROM file_search_chunks c JOIN ids USING(id)`, [this.options.spotChecks])).rows;
    let worst = 1;
    for (const row of sample) worst = Math.min(worst, cosineOf(parseVectorText(row.v), row.j.map(Number)));
    if (worst < 0.9999) { this.options.log(`vector verify failed: spot-check cosine ${ worst.toFixed(6) } < 0.9999; keeping embedding_json`); return false }
    this.options.log(`vector verify passed: ${ this.snapshot.embedded }/${ this.snapshot.chunks } chunks embedded, ${ sample.length } spot checks, min cosine ${ worst.toFixed(6) }`);
    return true;
  }

  /** Drops embedding_json and rewrites the table to return the space. Idempotent. */
  async reclaim():Promise<void> {
    this.phase = 'reclaim';
    const size = async() => Number((await this.db.query("SELECT pg_total_relation_size('file_search_chunks') n")).rows[0].n);
    const before = await size();
    await this.withLockRetry('ALTER TABLE file_search_chunks DROP COLUMN IF EXISTS embedding_json');
    await this.db.query('UPDATE files_vector_upgrade SET json_dropped_at=COALESCE(json_dropped_at,NOW())');
    this.snapshot.jsonColumn = false;
    await this.withLockRetry('VACUUM (FULL) file_search_chunks', 20, '30s');
    const after = await size();
    const reclaimed = Math.max(0, before - after);
    await this.db.query('UPDATE files_vector_upgrade SET reclaimed_at=NOW(),reclaimed_bytes=$1', [reclaimed]);
    this.snapshot.reclaimedBytes = reclaimed;
    this.options.log(`vector reclaim: dropped embedding_json, reclaimed ${ reclaimed } bytes (${ (reclaimed / 2 ** 30).toFixed(2) } GiB)`);
  }

  private async indexValidity():Promise<boolean | undefined> {
    const row = (await this.db.query(`SELECT i.indisvalid AND i.indisready valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname=$1 AND c.relnamespace=current_schema()::regnamespace`, [VECTOR_INDEX])).rows[0];
    return row ? Boolean(row.valid) : undefined;
  }

  async buildIndex():Promise<void> {
    this.phase = 'index';
    const existing = await this.indexValidity();
    if (existing === true) { this.snapshot.indexValid = true; return }
    const client = await this.db.connect();
    let failed:unknown;
    try {
      if (existing === false) {
        this.options.log(`vector index ${ VECTOR_INDEX } is INVALID (interrupted build); dropping and rebuilding`);
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${ VECTOR_INDEX }`);
      }
      // Session settings only. Parallel HNSW builds use dynamic shared memory,
      // which Docker caps at 64 MB by default, so build serially.
      await client.query(`SET maintenance_work_mem='${ this.options.maintenanceWorkMem.replace(/[^0-9A-Za-z]/g, '') }'`);
      await client.query('SET max_parallel_maintenance_workers=0');
      const started = Date.now();
      await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ VECTOR_INDEX } ON file_search_chunks USING hnsw (embedding vector_cosine_ops)`);
      this.options.log(`vector index built in ${ ((Date.now() - started) / 1000).toFixed(1) }s`);
    } catch (error) {
      failed = error; throw error;
    } finally {
      // A terminated build connection must not go back into the pool.
      client.release(failed instanceof Error ? failed : undefined);
    }
    const valid = await this.indexValidity();
    this.snapshot.indexValid = valid === true;
    if (valid !== true) throw new Error(`${ VECTOR_INDEX } is not valid after build`);
  }

  private async withLockRetry(sql:string, attempts = 10, timeout = '5s'):Promise<void> {
    for (let attempt = 1; ; attempt++) {
      this.checkStopped();
      const client = await this.db.connect();
      try {
        await client.query(`SET lock_timeout='${ timeout }'`);
        await client.query(sql);
        return;
      } catch (error:any) {
        if (error?.code !== '55P03' || attempt >= attempts) throw error;
      } finally {
        await client.query('RESET lock_timeout').catch(() => undefined);
        client.release();
      }
      await sleep(2_000);
    }
  }
}

/**
 * Explicit, operator-run step (never called automatically): runs the upgrade
 * with reclaim enabled, so embedding_json is dropped and the table rewritten
 * only after the same verification gate passes. Embeddings are derived data
 * (re-computable from `content` with the local model). Take a backup first.
 */
export async function reclaimJsonEmbeddings(db:pg.Pool, embedder:VectorEmbedder, options:Omit<VectorUpgradeOptions, 'reclaim'> = {}):Promise<VectorSearchStatus> {
  const upgrade = new VectorSearchUpgrade(db, embedder, { ...options, reclaim: true });
  await upgrade.upgrade();
  return upgrade.status();
}
