import { extractIndexText } from './extractor.js';
import { PotionEmbedder, vectorLiteral } from './potionEmbedder.js';

import type pg from 'pg';

const CHUNK_CHARS = 3_500;
const CHUNK_OVERLAP = 300;

function chunks(text:string):string[] {
  const output:string[] = [];
  for (let start = 0; start < text.length; start += CHUNK_CHARS - CHUNK_OVERLAP) {
    const content = text.slice(start, start + CHUNK_CHARS).trim();
    if (content) output.push(content);
  }
  return output;
}

export class IndexingQueue {
  private readonly embedder: PotionEmbedder;
  private timer?:            NodeJS.Timeout;
  private running = false;
  private vectorTable?:      boolean;

  constructor(private readonly db:pg.Pool, private readonly source:(file:any) => Promise<{ path: string; cleanup?: () => Promise<void> }>, model:PotionEmbedder | string) {
    this.embedder = typeof model === 'string' ? PotionEmbedder.load(model) : model;
    if (this.embedder.dim !== 256) throw new Error(`Expected 256-dimensional Potion model, got ${ this.embedder.dim }`);
  }

  async start():Promise<void> {
    await this.db.query("UPDATE file_index_jobs SET status='pending',available_at=NOW() WHERE status='indexing'");
    await this.db.query(`INSERT INTO file_index_jobs(file_id,version_id,status)
      SELECT f.id,f.current_version_id,'pending' FROM files f
      WHERE f.deleted_at IS NULL AND f.current_version_id IS NOT NULL AND f.extraction_status='pending'
      ON CONFLICT(version_id) DO NOTHING`);
    this.timer = setInterval(() => this.drain().catch(error => console.error('[SullaFiles] index queue failed', error)), 500);
    this.timer.unref(); this.wake();
  }

  close():void { if (this.timer) clearInterval(this.timer); }
  wake():void { setTimeout(() => this.drain().catch(error => console.error('[SullaFiles] index queue failed', error)), 0).unref() }
  async flush():Promise<void> {
    await this.drain();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }

  private async hasVectorTable():Promise<boolean> {
    if (this.vectorTable !== undefined) return this.vectorTable;
    this.vectorTable = Boolean((await this.db.query("SELECT to_regclass('file_search_vectors') name")).rows[0]?.name);
    return this.vectorTable;
  }

  private async drain():Promise<void> {
    if (this.running) return;
    this.running = true;
    try { while (await this.processOne()) { /* drain persisted work */ } } finally { this.running = false }
  }

  private async processOne():Promise<boolean> {
    const claimed = await this.db.query(`UPDATE file_index_jobs SET status='indexing',attempts=attempts+1,started_at=NOW(),last_error=NULL
      WHERE version_id=(SELECT version_id FROM file_index_jobs WHERE status='pending' AND available_at<=NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING file_id,version_id,attempts`);
    const job = claimed.rows[0]; if (!job) return false;
    try {
      const file = (await this.db.query('SELECT id,path,mime,current_version_id,deleted_at FROM files WHERE id=$1', [job.file_id])).rows[0];
      if (!file || file.deleted_at || file.current_version_id !== job.version_id) {
        await this.db.query('DELETE FROM file_index_jobs WHERE version_id=$1', [job.version_id]);
        return true;
      }
      const source = await this.source(file);
      const extracted = await extractIndexText(source.path, file.mime);
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        const current = (await client.query('SELECT current_version_id,deleted_at FROM files WHERE id=$1 FOR UPDATE', [file.id])).rows[0];
        if (!current || current.deleted_at || current.current_version_id !== job.version_id) {
          await client.query('DELETE FROM file_index_jobs WHERE version_id=$1', [job.version_id]);
          await client.query('COMMIT'); return true;
        }
        await client.query('DELETE FROM file_search_chunks WHERE file_id=$1', [file.id]);
        if (extracted.status === 'indexed' && extracted.text) {
          for (const [ordinal, content] of chunks(extracted.text).entries()) {
            const embedding = this.embedder.embed(content);
            const inserted = await client.query(`INSERT INTO file_search_chunks(file_id,version_id,ordinal,content,embedding_json)
              VALUES($1,$2,$3,$4,$5) RETURNING id`, [file.id, job.version_id, ordinal, content, JSON.stringify(Array.from(embedding))]);
            if (await this.hasVectorTable()) await client.query('INSERT INTO file_search_vectors(chunk_id,embedding) VALUES($1,$2::vector)', [inserted.rows[0].id, vectorLiteral(embedding)]);
          }
        }
        await client.query('UPDATE files SET search_text=$2,extracted_at=NOW(),extraction_status=$3 WHERE id=$1', [file.id, extracted.text, extracted.status]);
        await client.query('UPDATE file_index_jobs SET status=$2,finished_at=NOW() WHERE version_id=$1', [job.version_id, extracted.status]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release(); await source.cleanup?.() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = job.attempts >= 3;
      await this.db.query(`UPDATE file_index_jobs SET status=$2,last_error=$3,available_at=NOW()+INTERVAL '5 seconds',finished_at=CASE WHEN $2='failed' THEN NOW() END WHERE version_id=$1`, [job.version_id, terminal ? 'failed' : 'pending', message.slice(0, 500)]);
      if (terminal) await this.db.query("UPDATE files SET extraction_status='failed',extracted_at=NOW() WHERE id=$1 AND current_version_id=$2", [job.file_id, job.version_id]);
    }
    return true;
  }
}
