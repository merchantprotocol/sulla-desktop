// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// The concurrent-write benchmark rig: the real Files app (createApp) on its own Postgres schema with
// every migration, a production-shaped pool, the real IndexingQueue (stub embedder, real extractor)
// and the real audit drainer. Writers drive POST /v1/fuse/files over HTTP; a sampler watches
// pg_stat_activity for the longest open transaction. Only used when SULLA_FILES_TEST_DATABASE_URL is set.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

import { issueCapabilityToken } from '../src/auth.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { IndexingQueue } from '../src/indexing.js';
import { LocalFilesManager } from '../src/localManager.js';
import type { PotionEmbedder } from '../src/potionEmbedder.js';
import { Store } from '../src/store.js';
import { TransactionScope } from '../src/TransactionScope.js';

export interface BenchmarkOptions { writers:number; filesPerWriter:number; directories:number; indexer:boolean; audit:boolean }

export interface BenchmarkResult {
  files:number; seconds:number; filesPerSecond:number;
  p50:number; p95:number; p99:number; max:number;
  maxTransactionMs:number; failures:string[];
}

/** Percentiles over request latencies (milliseconds). */
export class LatencySample {
  private readonly values:number[] = [];
  add(ms:number):void { this.values.push(ms) }
  percentile(p:number):number {
    if (!this.values.length) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
  }
}

/** Polls pg_stat_activity for the longest-open transaction of the benchmark's own sessions. */
export class TransactionHoldSampler {
  private timer?:NodeJS.Timeout;
  maxMs = 0;
  /** With SULLA_FILES_BENCH_WAITS=1: how often each (wait event, statement) pair was seen. */
  readonly waits = new Map<string, number>();
  constructor(private readonly admin:pg.Pool, private readonly applicationName:string, private readonly recordWaits = process.env.SULLA_FILES_BENCH_WAITS === '1') {}
  start():void {
    this.timer = setInterval(() => {
      this.admin.query(`SELECT EXTRACT(EPOCH FROM clock_timestamp()-xact_start)*1000 AS ms,state,wait_event_type,wait_event,left(regexp_replace(query,'\\s+',' ','g'),70) AS q
        FROM pg_stat_activity WHERE application_name=$1 AND xact_start IS NOT NULL AND state<>'idle'`, [this.applicationName])
        .then(result => {
          for (const row of result.rows) {
            this.maxMs = Math.max(this.maxMs, Number(row.ms));
            if (this.recordWaits) { const key = `${ row.state }|${ row.wait_event_type ?? '-' }:${ row.wait_event ?? '-' }|${ row.q }`; this.waits.set(key, (this.waits.get(key) ?? 0) + 1) }
          }
        }).catch(() => undefined);
    }, 20);
  }
  topWaits(limit = 25):string { return [...this.waits].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([key, n]) => `${ String(n).padStart(6) } ${ key }`).join('\n') }
  stop():void { if (this.timer) clearInterval(this.timer) }
}

/** A text-only index source and a fixed-vector embedder, so indexing exercises only its database work. */
class BenchmarkIndexSource {
  constructor(private readonly path:string) {}
  readonly source = async() => ({ path: this.path });
  static embedder():PotionEmbedder {
    return { dim: 512, embed: () => new Float32Array(512) } as unknown as PotionEmbedder;
  }
}

export class FilesWriteBenchmark {
  readonly schema = `files_bench_${ randomUUID().replaceAll('-', '') }`;
  readonly applicationName = `files-bench-${ randomUUID().slice(0, 8) }`;
  readonly userId = 'bench-user';
  readonly collectionId = randomUUID();
  readonly logsCollectionId = randomUUID();
  private readonly signingKey = Buffer.alloc(32, 7);
  private readonly admin:pg.Pool;
  pool!:pg.Pool;
  private root = '';
  private server?:Server;
  private baseUrl = '';
  private indexer?:IndexingQueue;
  private auditTimer?:NodeJS.Timeout;
  private auditWriter?:{ drain():Promise<void> };

  constructor(private readonly databaseUrl:string, private readonly options:BenchmarkOptions) {
    this.admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  }

  async start():Promise<void> {
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    // Shaped like FilesDatabase.connect: 12 sessions and the production timeouts.
    this.pool = TransactionScope.guardPool(new pg.Pool({ connectionString: this.databaseUrl, max: 12, application_name: this.applicationName,
      options: `-csearch_path=${ this.schema },public`, connectionTimeoutMillis: 20_000, idle_in_transaction_session_timeout: 15_000, statement_timeout: 30_000 }));
    await migrate(this.pool);
    this.root = await mkdtemp(join(tmpdir(), 'sulla-files-bench-'));
    const filesRoot = join(this.root, 'files'); const chunkRoot = join(this.root, 'chunks');
    await mkdir(filesRoot, { recursive: true }); await mkdir(chunkRoot, { recursive: true });
    const keyring = { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) };
    const config:any = { port: 0, databaseUrl: this.databaseUrl, chunkRoot, dataRoot: this.root, filesRoot, caseInsensitiveRoot: false,
      capabilitySigningKey: this.signingKey, mode: 'desktop', deviceId: 'local-device', userId: this.userId, localToken: 'test-local', cloudUrl: '', paused: true, modelDir: this.root,
      fuseExperiment: true, keyring, fileRoots: [{ id: 'default', name: 'Files', path: filesRoot, syncMode: 'local', paused: true, exclusions: [], primary: true }] };
    await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
      VALUES($1,$2,'Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,'bench-files')`, [this.collectionId, this.userId]);
    await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path,system_area)
      VALUES($1,$2,'Logs','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE,'Logs','logs')`, [this.logsCollectionId, this.userId]);
    if (this.options.indexer) {
      const text = join(this.root, 'index-source.txt'); await writeFile(text, 'benchmark indexed text '.repeat(40));
      const source = new BenchmarkIndexSource(text);
      this.indexer = new IndexingQueue(this.pool, source.source, BenchmarkIndexSource.embedder());
    }
    const manager = new LocalFilesManager(this.pool, config, this.indexer);
    (manager as any).rootCollections.set('default', this.collectionId);
    const app = createApp(this.pool, config, manager, undefined, undefined, undefined, undefined, undefined, undefined, undefined, this.indexer, new Store(chunkRoot));
    this.auditWriter = app.locals.auditWriter;
    this.server = createServer(app);
    await new Promise<void>(done => this.server!.listen(0, '127.0.0.1', done));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('benchmark server did not bind');
    this.baseUrl = `http://127.0.0.1:${ address.port }`;
  }

  /** Starts the background work production runs next to the writers. */
  startBackground():void {
    if (this.indexer) void this.indexer.start();
    if (this.options.audit && this.auditWriter) {
      const writer = this.auditWriter;
      this.auditTimer = setInterval(() => { void writer.drain().catch(() => undefined) }, 200);
    }
  }

  async stopBackground():Promise<void> {
    if (this.auditTimer) clearInterval(this.auditTimer);
    await this.indexer?.close();
  }

  async stop():Promise<void> {
    await this.stopBackground();
    await new Promise(done => this.server ? this.server.close(done) : done(undefined));
    await this.pool?.end();
    await this.admin.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`); await this.admin.end();
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }

  /** Every path the run writes, in writer order. */
  paths(runId:string):string[][] {
    const { writers, filesPerWriter, directories } = this.options;
    return Array.from({ length: writers }, (_w, writer) => Array.from({ length: filesPerWriter },
      (_f, index) => `bench/${ runId }/d${ (writer * filesPerWriter + index) % directories }/w${ writer }-${ index }.txt`));
  }

  /** N writers, each creating its files one after another through the mount create route. */
  async run(runId:string):Promise<BenchmarkResult> {
    const latencies = new LatencySample(); const failures:string[] = [];
    const sampler = new TransactionHoldSampler(this.admin, this.applicationName);
    const token = issueCapabilityToken({ sub: this.userId, device_id: 'bench-device', scopes: ['files/*'], job_id: 'bench-job' }, this.signingKey);
    const started = performance.now(); sampler.start();
    await Promise.all(this.paths(runId).map(async paths => {
      for (const path of paths) {
        const body = randomBytes(512 + Math.floor(Math.random() * 1024)).toString('base64');
        const begin = performance.now();
        const reply = await this.post(`/v1/fuse/files?collectionId=${ this.collectionId }&path=${ encodeURIComponent(path) }`, Buffer.from(body), token);
        latencies.add(performance.now() - begin);
        if (reply.status !== 201) failures.push(`${ path }: ${ reply.status } ${ reply.body }`);
      }
    }));
    const seconds = (performance.now() - started) / 1000; sampler.stop();
    if (sampler.waits.size) console.log(`[files-bench] top waits (samples every 20ms):\n${ sampler.topWaits() }`);
    const files = this.options.writers * this.options.filesPerWriter;
    return { files, seconds, filesPerSecond: files / seconds, p50: latencies.percentile(50), p95: latencies.percentile(95), p99: latencies.percentile(99),
      max: latencies.percentile(100), maxTransactionMs: sampler.maxMs, failures };
  }

  /** Live file rows under the run's prefix, with how many rows share each path. */
  async storedPaths(runId:string):Promise<Map<string, number>> {
    const rows = await this.pool.query(`SELECT path,COUNT(*)::int AS n FROM files
      WHERE collection_id=$1 AND starts_with(path,$2) AND deleted_at IS NULL AND current_version_id IS NOT NULL GROUP BY path`, [this.collectionId, `bench/${ runId }/`]);
    return new Map(rows.rows.map((row:{ path:string; n:number }) => [row.path, row.n]));
  }

  async scalar(sql:string, values:unknown[] = []):Promise<number> { return Number((await this.pool.query(sql, values)).rows[0].n) }

  private post(path:string, body:Buffer, token:string):Promise<{ status:number; body:string }> {
    const headers = { 'x-sulla-files-token': 'test-local', authorization: `Bearer ${ token }`, 'content-type': 'text/plain', 'content-length': String(body.length) };
    return new Promise((done, reject) => {
      const request = httpRequest(new URL(path, this.baseUrl), { method: 'POST', headers, agent: false }, response => {
        const parts:Buffer[] = []; response.on('data', part => parts.push(Buffer.from(part)));
        response.on('end', () => done({ status: response.statusCode ?? 500, body: Buffer.concat(parts).toString('utf8').slice(0, 300) }));
      });
      request.on('error', reject); request.write(body); request.end();
    });
  }
}
