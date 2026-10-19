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
  private stopped = false;
  private vectorTable?:      boolean;

  constructor(private readonly db:pg.Pool, private readonly source:(file:any) => Promise<{ path: string; cleanup?: () => Promise<void> }>, model:PotionEmbedder | string) {
    this.embedder = typeof model === 'string' ? PotionEmbedder.load(model) : model;
    if (this.embedder.dim !== 512) throw new Error(`Expected 512-dimensional Potion model, got ${ this.embedder.dim }`);
  }

  async start():Promise<void> {
    this.stopped = false;
    await this.db.query("UPDATE file_index_jobs SET status='pending',reason_code='interrupted',reason='Indexing was interrupted and will retry.',available_at=NOW() WHERE status='indexing'");
    await this.db.query(`INSERT INTO file_index_jobs(file_id,version_id,status)
      SELECT f.id,f.current_version_id,'pending' FROM files f
      WHERE f.deleted_at IS NULL AND f.current_version_id IS NOT NULL AND f.extraction_status='pending'
      ON CONFLICT(version_id) DO NOTHING`);
    await this.db.query(`UPDATE files f SET extraction_status='failed',extracted_at=NOW(),extraction_reason_code='missing_job',extraction_reason='The indexing queue record was missing. Re-index this file.'
      WHERE f.deleted_at IS NULL AND f.current_version_id IS NOT NULL AND f.extraction_status IN('pending','indexing')
      AND NOT EXISTS(SELECT 1 FROM file_index_jobs j WHERE j.version_id=f.current_version_id)`);
    this.timer = setInterval(() => this.drain().catch(error => console.error('[SullaFiles] index queue failed', error)), 500);
    this.timer.unref(); this.wake();
  }

  async close():Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); while (this.running) await new Promise(resolve => setTimeout(resolve, 10)); }
  wake():void { setTimeout(() => this.drain().catch(error => console.error('[SullaFiles] index queue failed', error)), 0).unref() }
  async flush():Promise<void> {
    await this.drain();
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }

  async retry(fileId:string):Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const file = (await client.query('SELECT current_version_id,deleted_at FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
      if (!file || file.deleted_at || !file.current_version_id) throw new Error('Only a current, active file can be re-indexed.');
      await client.query('DELETE FROM file_search_chunks WHERE file_id=$1', [fileId]);
      await client.query(`INSERT INTO file_index_jobs(file_id,version_id,status,attempts,last_error,available_at,started_at,finished_at,reason_code,reason)
        VALUES($1,$2,'pending',0,NULL,NOW(),NULL,NULL,'manual_retry','Waiting for local indexing.')
        ON CONFLICT(version_id) DO UPDATE SET status='pending',attempts=0,last_error=NULL,available_at=NOW(),started_at=NULL,finished_at=NULL,reason_code='manual_retry',reason='Waiting for local indexing.'`, [fileId, file.current_version_id]);
      await client.query("UPDATE files SET search_text=NULL,extracted_at=NULL,extraction_status='pending',extraction_reason_code='manual_retry',extraction_reason='Waiting for local indexing.' WHERE id=$1", [fileId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    this.wake();
  }

  private async hasVectorTable():Promise<boolean> {
    if (this.vectorTable !== undefined) return this.vectorTable;
    this.vectorTable = Boolean((await this.db.query("SELECT to_regclass('file_search_vectors') name")).rows[0]?.name);
    return this.vectorTable;
  }

  private async drain():Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try { while (!this.stopped && await this.processOne()) { /* drain persisted work */ } } finally { this.running = false }
  }

  private async processOne():Promise<boolean> {
    const claimed = await this.db.query(`UPDATE file_index_jobs SET status='indexing',attempts=attempts+1,started_at=NOW(),last_error=NULL,reason_code='indexing',reason='Local extraction is in progress.'
      WHERE version_id=(SELECT version_id FROM file_index_jobs WHERE status='pending' AND available_at<=NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING file_id,version_id,attempts`);
    const job = claimed.rows[0]; if (!job) return false;
    let source:{ path: string; cleanup?: () => Promise<void> } | undefined;
    try {
      await this.db.query("UPDATE files SET extraction_status='indexing',extraction_reason_code='indexing',extraction_reason='Local extraction is in progress.' WHERE id=$1 AND current_version_id=$2", [job.file_id, job.version_id]);
      const file = (await this.db.query('SELECT id,path,mime,current_version_id,deleted_at FROM files WHERE id=$1', [job.file_id])).rows[0];
      if (!file || file.deleted_at || file.current_version_id !== job.version_id) {
        await this.db.query('DELETE FROM file_index_jobs WHERE version_id=$1', [job.version_id]);
        return true;
      }
      source = await this.source(file);
      const extracted = await extractIndexText(source.path, file.mime);
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        const current = (await client.query('SELECT current_version_id,deleted_at FROM files WHERE id=$1 FOR UPDATE', [file.id])).rows[0];
        if (!current || current.deleted_at || current.current_version_id !== job.version_id) {
          await client.query('DELETE FROM file_index_jobs WHERE version_id=$1', [job.version_id]);
          await client.query('COMMIT'); return true;
        }
        const activeJob = (await client.query('SELECT status,attempts FROM file_index_jobs WHERE version_id=$1 FOR UPDATE', [job.version_id])).rows[0];
        if (!activeJob || activeJob.status !== 'indexing' || Number(activeJob.attempts) !== Number(job.attempts)) {
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
        await client.query('UPDATE files SET search_text=$2,extracted_at=NOW(),extraction_status=$3,extraction_reason_code=$4,extraction_reason=$5 WHERE id=$1', [file.id, extracted.text, extracted.status, extracted.reasonCode, extracted.reason]);
        await client.query('UPDATE file_index_jobs SET status=$2,finished_at=NOW(),reason_code=$3,reason=$4,last_error=NULL WHERE version_id=$1', [job.version_id, extracted.status, extracted.reasonCode, extracted.reason]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    } catch (error) {
      const terminal = job.attempts >= 3;
      const status = terminal ? 'failed' : 'pending';
      const reason = terminal ? 'Indexing failed after three local attempts. Re-index to try again.' : 'Indexing hit a temporary local error and will retry.';
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        const current = (await client.query('SELECT current_version_id,deleted_at FROM files WHERE id=$1 FOR UPDATE', [job.file_id])).rows[0];
        if (current && !current.deleted_at && current.current_version_id === job.version_id) {
          const updated = await client.query(`UPDATE file_index_jobs SET status=$2,last_error=$3,reason_code=$4,reason=$5,available_at=NOW()+INTERVAL '5 seconds',finished_at=CASE WHEN $2='failed' THEN NOW() END
            WHERE version_id=$1 AND status='indexing' AND attempts=$6`, [job.version_id, status, 'Local indexing operation failed', terminal ? 'retry_exhausted' : 'retry_scheduled', reason, job.attempts]);
          if (updated.rowCount) await client.query('UPDATE files SET extraction_status=$3,extraction_reason_code=$4,extraction_reason=$5,extracted_at=CASE WHEN $3=\'failed\' THEN NOW() ELSE NULL END WHERE id=$1 AND current_version_id=$2', [job.file_id, job.version_id, status, terminal ? 'retry_exhausted' : 'retry_scheduled', reason]);
        }
        await client.query('COMMIT');
      } catch (failureError) { await client.query('ROLLBACK'); throw failureError } finally { client.release() }
    } finally {
      try { await source?.cleanup?.() } catch { console.warn('[SullaFiles] index source cleanup failed') }
    }
    return true;
  }
}
