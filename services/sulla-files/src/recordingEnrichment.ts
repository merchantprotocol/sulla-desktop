// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

import { UNINDEXED_SYSTEM_AREAS } from './systemAreaIngest.js';

import type pg from 'pg';

const run = promisify(execFile);

export interface Segment { start: number; end: number; text: string }
interface Runtime { whisper: string; model: string; ffmpeg?: string }

async function executable(candidates:(string | undefined)[]):Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { await access(candidate); return candidate } catch { /* try the next supported location */ }
  }
}

async function runtime():Promise<Runtime | undefined> {
  const whisper = await executable([
    process.env.WHISPER_CPP_BIN, '/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli', '/app/bin/whisper-cli',
  ]);
  const model = await executable([
    process.env.WHISPER_CPP_MODEL, '/var/lib/sulla-files/models/ggml-tiny-q5_1.bin', '/app/models/ggml-tiny-q5_1.bin',
  ]);
  if (!whisper || !model) return undefined;
  const ffmpeg = await executable([process.env.FFMPEG_BIN, '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);

  return { whisper, model, ffmpeg };
}

function seconds(value:unknown, scale = 1):number {
  if (typeof value === 'string' && /^\d\d:\d\d:\d\d[,.]\d+$/.test(value)) {
    const [hours, minutes, tail] = value.replace(',', '.').split(':');
    return Number(hours) * 3_600 + Number(minutes) * 60 + Number(tail);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return numeric / scale;
}

function normalize(raw:any):Segment[] {
  const source = raw?.transcription ?? raw?.segments ?? [];

  return source.map((entry:any) => ({
    start: entry?.timestamps?.from !== undefined ? seconds(entry.timestamps.from, 1_000) : entry?.t0 !== undefined ? seconds(entry.t0, 100) : seconds(entry?.start),
    end:   entry?.timestamps?.to !== undefined ? seconds(entry.timestamps.to, 1_000) : entry?.t1 !== undefined ? seconds(entry.t1, 100) : seconds(entry?.end),
    text:  String(entry?.text ?? entry?.offsets?.text ?? '').trim(),
  })).filter((entry:Segment) => entry.text);
}

function title(text:string):string {
  const cleaned = text.replace(/\s+/g, ' ').replace(/^[\s.,!?;:-]+/, '').trim();
  if (!cleaned) return 'Recording';

  return cleaned.split(' ').slice(0, 9).join(' ').replace(/[.,!?;:]+$/, '');
}

function chapters(segments:Segment[]):Array<{ start:number; end:number; title:string }> {
  if (!segments.length) return [];
  const groups:Array<{ start:number; end:number; text:string }> = [];
  for (const segment of segments) {
    const current = groups.at(-1);
    if (!current || segment.start - current.start >= 90) groups.push({ start: segment.start, end: segment.end, text: segment.text });
    else { current.end = segment.end; current.text += ` ${ segment.text }` }
  }

  return groups.map(group => ({ start: Math.round(group.start), end: Math.max(Math.round(group.end), Math.round(group.start) + 1), title: title(group.text) }));
}


export interface RecordingEnrichmentOutput {
  fileId: string;
  versionId: string;
  language: string | null;
  transcript: Segment[];
  chapters: Array<{ start:number; end:number; title:string }>;
  duration: number | null;
}

/** Final, lock-protected persistence boundary for transcript-derived plaintext. */
export async function persistRecordingEnrichment(db:pg.Pool, output:RecordingEnrichmentOutput):Promise<'stored' | 'abandoned-ineligible' | 'abandoned-stale'> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock first, then re-read eligibility in a new statement. A single locking
    // SELECT keeps its pre-wait snapshot for subqueries and can miss protection
    // committed while it waits on the file row.
    const locked = (await client.query('SELECT collection_id FROM files WHERE id=$1 FOR UPDATE', [output.fileId])).rows[0];
    if (locked) await client.query('SELECT id FROM collections WHERE id=$1 FOR UPDATE', [locked.collection_id]);
    const file = (await client.query(`SELECT f.path,f.current_version_id,f.deleted_at,c.system_area,
      EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) protected
      FROM files f JOIN collections c ON c.id=f.collection_id WHERE f.id=$1`, [output.fileId])).rows[0];
    if (!file || file.deleted_at || file.protected || UNINDEXED_SYSTEM_AREAS.has(file.system_area)) {
      await client.query('DELETE FROM recording_metadata WHERE file_id=$1', [output.fileId]);
      await client.query('DELETE FROM file_search_text WHERE file_id=$1', [output.fileId]);
      await client.query('DELETE FROM file_search_chunks WHERE file_id=$1', [output.fileId]);
      await client.query('DELETE FROM file_index_jobs WHERE file_id=$1', [output.fileId]);
      await client.query('DELETE FROM recording_enrichment_jobs WHERE file_id=$1', [output.fileId]);
      await client.query('COMMIT');
      return 'abandoned-ineligible';
    }
    if (file.current_version_id !== output.versionId) {
      await client.query('DELETE FROM recording_enrichment_jobs WHERE version_id=$1', [output.versionId]);
      await client.query('COMMIT');
      return 'abandoned-stale';
    }
    await client.query(`INSERT INTO recording_metadata(file_id,version_id,language,transcript,chapters,duration_seconds,generator)
      VALUES($1,$2,$3,$4,$5,$6,'whisper.cpp') ON CONFLICT(file_id) DO UPDATE SET version_id=EXCLUDED.version_id,language=EXCLUDED.language,
      transcript=EXCLUDED.transcript,chapters=EXCLUDED.chapters,duration_seconds=EXCLUDED.duration_seconds,generator=EXCLUDED.generator,generated_at=NOW()`,
    [output.fileId, output.versionId, output.language, JSON.stringify(output.transcript), JSON.stringify(output.chapters), output.duration]);
    const text = output.transcript.map(segment => segment.text).join(' ');
    await client.query('UPDATE file_search_text SET search_text=$2 WHERE file_id=$1', [output.fileId, text]);
    await client.query("UPDATE files SET extraction_status='indexed',extracted_at=NOW() WHERE id=$1", [output.fileId]);
    await client.query("UPDATE recording_enrichment_jobs SET status='completed',finished_at=NOW() WHERE version_id=$1", [output.versionId]);
    await client.query('COMMIT');
    return 'stored';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Persisted recording enrichment queue. The Files image ships a pinned local
 * whisper.cpp runtime and model; explicit overrides remain available for
 * operators that want a larger model.
 */
export class RecordingEnrichmentQueue {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly db:pg.Pool, private readonly filesRoot:string) {}

  async start():Promise<void> {
    this.stopped = false;
    await this.db.query("UPDATE recording_enrichment_jobs SET status='pending',available_at=NOW(),started_at=NULL WHERE status='processing'");
    if (await runtime()) await this.db.query("UPDATE recording_enrichment_jobs SET status='pending',available_at=NOW() WHERE status='waiting_runtime'");
    this.timer = setInterval(() => this.drain().catch(error => console.error('[SullaFiles] recording enrichment failed', error)), 2_000);
    this.timer.unref();
    this.wake();
  }

  async close():Promise<void> { this.stopped = true; if (this.timer) clearInterval(this.timer); while (this.running) await new Promise(resolve => setTimeout(resolve, 10)); }
  wake():void { setTimeout(() => this.drain().catch(error => console.error('[SullaFiles] recording enrichment failed', error)), 0).unref() }

  private async drain():Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try { while (!this.stopped && await this.processOne()) { /* drain persisted jobs */ } } finally { this.running = false }
  }

  private async processOne():Promise<boolean> {
    const claimed = await this.db.query(`UPDATE recording_enrichment_jobs SET status='processing',attempts=attempts+1,started_at=NOW(),last_error=NULL
      WHERE version_id=(SELECT version_id FROM recording_enrichment_jobs WHERE status='pending' AND available_at<=NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING file_id,version_id,attempts`);
    const job = claimed.rows[0]; if (!job) return false;
    const tools = await runtime();
    if (!tools) {
      await this.db.query("UPDATE recording_enrichment_jobs SET status='waiting_runtime',last_error='whisper.cpp model/runtime not installed' WHERE version_id=$1", [job.version_id]);
      return true;
    }

    let temp = '';
    try {
      const file = (await this.db.query('SELECT id,path,current_version_id,deleted_at FROM files WHERE id=$1', [job.file_id])).rows[0];
      if (!file || file.deleted_at || file.current_version_id !== job.version_id) {
        await this.db.query('DELETE FROM recording_enrichment_jobs WHERE version_id=$1', [job.version_id]);
        return true;
      }
      temp = await mkdtemp(join(tmpdir(), 'sulla-files-whisper-'));
      const input = join(this.filesRoot, file.path); const stem = input.slice(0, -extname(input).length);
      const mic = `${ stem }-mic.webm`; let source = input;
      try { await access(mic); source = mic } catch { /* screen recordings can contain their own audio */ }
      let audio = source;
      if (extname(source).toLowerCase() !== '.wav') {
        if (!tools.ffmpeg) throw new Error('ffmpeg is required to decode this recording');
        audio = join(temp, 'audio.wav');
        await run(tools.ffmpeg, ['-y', '-i', source, '-ar', '16000', '-ac', '1', audio], { timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
      }
      const output = join(temp, 'transcript');
      await run(tools.whisper, ['-m', tools.model, '-f', audio, '-oj', '-of', output], { timeout: 60 * 60_000, maxBuffer: 4 * 1024 * 1024 });
      const raw = JSON.parse(await readFile(`${ output }.json`, 'utf8'));
      const transcript = normalize(raw); const chapterList = chapters(transcript);
      const duration = transcript.at(-1)?.end ?? null; const language = raw?.result?.language ?? raw?.language ?? null;
      const outcome = await persistRecordingEnrichment(this.db, {
        fileId: file.id, versionId: job.version_id, language, transcript, chapters: chapterList, duration,
      });
      if (outcome === 'stored') console.log(`[SullaFiles] enriched recording ${ basename(file.path) } with ${ transcript.length } transcript segments and ${ chapterList.length } chapters`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); const terminal = job.attempts >= 3;
      await this.db.query(`UPDATE recording_enrichment_jobs SET status=$2,last_error=$3,available_at=NOW()+INTERVAL '30 seconds',finished_at=CASE WHEN $2='failed' THEN NOW() END WHERE version_id=$1`, [job.version_id, terminal ? 'failed' : 'pending', message.slice(0, 500)]);
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
    return true;
  }
}
