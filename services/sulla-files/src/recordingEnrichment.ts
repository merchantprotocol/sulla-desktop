import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

import type pg from 'pg';

const run = promisify(execFile);

interface Segment { start: number; end: number; text: string }
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
    process.env.WHISPER_CPP_MODEL, '/var/lib/sulla-files/models/ggml-base.en.bin', '/app/models/ggml-base.en.bin',
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

/**
 * Persisted recording enrichment queue. The Files image may omit whisper.cpp;
 * jobs then remain in waiting_runtime and are retried when the coordinated
 * Phase 6 image supplies WHISPER_CPP_BIN + WHISPER_CPP_MODEL.
 */
export class RecordingEnrichmentQueue {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly db:pg.Pool, private readonly filesRoot:string) {}

  async start():Promise<void> {
    if (await runtime()) await this.db.query("UPDATE recording_enrichment_jobs SET status='pending',available_at=NOW() WHERE status='waiting_runtime'");
    this.timer = setInterval(() => this.drain().catch(error => console.error('[SullaFiles] recording enrichment failed', error)), 2_000);
    this.timer.unref();
    this.wake();
  }

  close():void { if (this.timer) clearInterval(this.timer) }
  wake():void { setTimeout(() => this.drain().catch(error => console.error('[SullaFiles] recording enrichment failed', error)), 0).unref() }

  private async drain():Promise<void> {
    if (this.running) return;
    this.running = true;
    try { while (await this.processOne()) { /* drain persisted jobs */ } } finally { this.running = false }
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
      await this.db.query(`INSERT INTO recording_metadata(file_id,version_id,language,transcript,chapters,duration_seconds,generator)
        VALUES($1,$2,$3,$4,$5,$6,'whisper.cpp') ON CONFLICT(file_id) DO UPDATE SET version_id=EXCLUDED.version_id,language=EXCLUDED.language,
        transcript=EXCLUDED.transcript,chapters=EXCLUDED.chapters,duration_seconds=EXCLUDED.duration_seconds,generator=EXCLUDED.generator,generated_at=NOW()`,
      [file.id, job.version_id, language, JSON.stringify(transcript), JSON.stringify(chapterList), duration]);
      const text = transcript.map(segment => segment.text).join(' ');
      const hasSearchText = Boolean((await this.db.query("SELECT 1 FROM information_schema.columns WHERE table_name='files' AND column_name='search_text'")).rowCount);
      if (hasSearchText) await this.db.query("UPDATE files SET search_text=$2,extraction_status='indexed',extracted_at=NOW() WHERE id=$1", [file.id, text]);
      await this.db.query("UPDATE recording_enrichment_jobs SET status='completed',finished_at=NOW() WHERE version_id=$1", [job.version_id]);
      console.log(`[SullaFiles] enriched recording ${ basename(file.path) } with ${ transcript.length } transcript segments and ${ chapterList.length } chapters`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); const terminal = job.attempts >= 3;
      await this.db.query(`UPDATE recording_enrichment_jobs SET status=$2,last_error=$3,available_at=NOW()+INTERVAL '30 seconds',finished_at=CASE WHEN $2='failed' THEN NOW() END WHERE version_id=$1`, [job.version_id, terminal ? 'failed' : 'pending', message.slice(0, 500)]);
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
    return true;
  }
}
