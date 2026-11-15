// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// The Files mount write path through the real Files routes and a real Postgres, under the load the
// million-file torture test applies (many concurrent creates against a small connection pool).
// Requires SULLA_TEST_DATABASE_URL (a throwaway Postgres 16).
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { issueCapabilityToken } from '../../../../../services/sulla-files/src/auth.js';
import { migrate } from '../../../../../services/sulla-files/src/db.js';
import { LocalFilesManager } from '../../../../../services/sulla-files/src/localManager.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

const databaseUrl = process.env.SULLA_TEST_DATABASE_URL ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const sha256 = (value:Buffer | string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));

interface Reply { status:number; body:any; headers:Record<string, string | string[] | undefined> }

/** Boots the real Files app on a small pool, the way the mount talks to it. */
class MountWriteFixture {
  readonly schema = `files_mount_write_${ randomUUID().replaceAll('-', '') }`;
  readonly applicationName = `files-mount-write-${ randomUUID().slice(0, 8) }`;
  private readonly signingKey = Buffer.alloc(32, 9);
  private readonly userId = 'mount-write-user';
  readonly admin:Pool;
  pool?:Pool;
  private server?:Server;
  private manager?:LocalFilesManager;
  private root = '';
  private baseUrl = '';
  collectionId = '';

  constructor(private readonly url:string, private readonly poolMax:number) { this.admin = new Pool({ connectionString: url, max: 3 }) }

  async initialize():Promise<void> {
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    this.pool = new Pool({ connectionString: this.url, max: this.poolMax, application_name: this.applicationName, options: `-csearch_path=${ this.schema },public` });
    this.pool.on('error', () => undefined);
    this.pool.on('connect', client => client.on('error', () => undefined));
    await migrate(this.pool);
    this.root = await mkdtemp(join(tmpdir(), 'sulla-mount-write-'));
    const filesRoot = join(this.root, 'files'); const chunkRoot = join(this.root, 'chunks');
    await mkdir(filesRoot, { recursive: true }); await mkdir(chunkRoot, { recursive: true });
    const keyring = { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) };
    const config:any = { port: 0, databaseUrl: this.url, chunkRoot, dataRoot: this.root, filesRoot, caseInsensitiveRoot: false,
      capabilitySigningKey: this.signingKey, mode: 'desktop', deviceId: 'local-device', userId: this.userId, cloudUrl: '', paused: true, modelDir: this.root,
      fuseExperiment: true, keyring, fileRoots: [{ id: 'default', name: 'Files', path: filesRoot, syncMode: 'local', paused: true, exclusions: [], primary: true }] };
    this.collectionId = randomUUID();
    await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source)
      VALUES($1,$2,'Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE)`, [this.collectionId, this.userId]);
    await this.pool.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage')", [this.collectionId, this.userId]);
    this.manager = new LocalFilesManager(this.pool, config);
    (this.manager as any).rootCollections.set('default', this.collectionId);
    const appModulePath = '../../../../../services/sulla-files/src/app.js';
    const { createApp } = await import(appModulePath);
    this.server = createServer(createApp(this.pool, config, this.manager));
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('test server did not bind');
    this.baseUrl = `http://127.0.0.1:${ address.port }`;
  }

  request(path:string, method:string, body?:Buffer, headers:Record<string, string> = {}):Promise<Reply> {
    const token = issueCapabilityToken({ sub: this.userId, device_id: 'test-device', scopes: ['files/*'], agent_id: 'torture-agent', job_id: 'torture-job' }, this.signingKey);
    return new Promise((resolve, reject) => {
      const request = httpRequest(new URL(path, this.baseUrl), { method, headers: { authorization: `Bearer ${ token }`, 'x-sulla-actor': 'torture-agent:torture-job', ...headers } }, response => {
        const chunks:Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let parsed:any = text; try { parsed = text ? JSON.parse(text) : {} } catch { /* content */ }
          resolve({ status: response.statusCode ?? 500, body: parsed, headers: response.headers }) });
      });
      request.on('error', reject); if (body) request.write(body); request.end();
    });
  }

  /** What the mount does for `echo content > path`: create empty, then write the content against that version. */
  async createAndWrite(path:string, content:Buffer):Promise<{ fileId:string; versionId:string; ms:number }> {
    const started = performance.now();
    const created = await this.request(`/v1/fuse/files?collectionId=${ this.collectionId }&path=${ encodeURIComponent(path) }`, 'POST', Buffer.alloc(0), { 'content-type': 'application/octet-stream' });
    if (created.status !== 201) throw new Error(`create ${ created.status } ${ JSON.stringify(created.body) }`);
    const written = await this.write(created.body.id, created.body.current_version_id, sha256(''), content);
    if (written.status !== 200) throw new Error(`write ${ written.status } ${ JSON.stringify(written.body) }`);
    return { fileId: created.body.id, versionId: written.body.versionId, ms: performance.now() - started };
  }

  write(fileId:string, ifMatch:string, sourceHash:string, content:Buffer):Promise<Reply> {
    return this.request(`/v1/fuse/files/${ fileId }/content`, 'PUT', content, { 'content-type': 'application/octet-stream', 'if-match': `"${ ifMatch }"`, 'x-sulla-source-hash': sourceHash });
  }

  async read(fileId:string):Promise<string> { const reply = await this.request(`/v1/fuse/files/${ fileId }/content`, 'GET'); return typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body) }

  /** Connections of this app left idle inside a transaction for longer than a statement round trip. */
  watchIdleTransactions():{ stop:() => Promise<string[]> } {
    const seen:string[] = []; let running = true;
    const loop = (async() => {
      while (running) {
        const rows = (await this.admin.query(`SELECT state FROM pg_stat_activity WHERE application_name=$1 AND state LIKE 'idle in transaction%'
          AND clock_timestamp()-state_change > interval '250 milliseconds'`, [this.applicationName])).rows;
        seen.push(...rows.map(row => row.state)); await sleep(25);
      }
    })();
    return { stop: async() => { running = false; await loop; return seen } };
  }

  async dispose():Promise<void> {
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    await this.manager?.close(); await this.pool?.end();
    await this.admin.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`); await this.admin.end();
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}

describeWithDatabase('Files mount write path under load (real routes, real Postgres)', () => {
  const fixture = new MountWriteFixture(databaseUrl, 4);
  beforeAll(() => fixture.initialize(), 120_000);
  afterAll(() => fixture.dispose());

  it('writes 24 concurrent files through a 4-connection pool with no stalled transaction', async() => {
    // risk: data loss under load — creates held a pooled client while waiting on the pool for another,
    // and writes held BEGIN across chunk I/O, so a burst starved the pool until Postgres killed them.
    const watcher = fixture.watchIdleTransactions();
    const files = Array.from({ length: 24 }, (_, index) => ({ path: `Stress/burst/f${ String(index).padStart(5, '0') }.txt`, content: Buffer.from(`file ${ index } `.repeat(150)) }));
    const results = await Promise.all(files.map(file => fixture.createAndWrite(file.path, file.content)));
    const stalled = await watcher.stop();
    expect(stalled).toEqual([]);
    for (const [index, result] of results.entries()) expect(await fixture.read(result.fileId)).toBe(files[index].content.toString());
    const latencies = results.map(result => result.ms).sort((a, b) => a - b);
    console.info('[mount-write] burst of 24 create+write (pool 4): p50 %dms p95 %dms', Math.round(latencies[12]), Math.round(latencies[22]));
  }, 60_000);

  it('answers a retried write from the version its first attempt committed', async() => {
    // risk: duplicate versions / EPERM — a PUT whose reply was lost must not fail or write twice on retry.
    const content = Buffer.from('replayed content\n');
    const first = await fixture.createAndWrite('Stress/replay/a.txt', content);
    const created = (await fixture.pool!.query('SELECT parent_version_id FROM file_versions WHERE id=$1', [first.versionId])).rows[0].parent_version_id;
    const replay = await fixture.write(first.fileId, created, sha256(''), content);
    expect(replay.status).toBe(200);
    expect(replay.body.versionId).toBe(first.versionId);
    expect(Number((await fixture.pool!.query('SELECT count(*) FROM file_versions WHERE file_id=$1', [first.fileId])).rows[0].count)).toBe(2);
  }, 30_000);

  it('returns a retryable 503 and saves nothing when the connection dies mid-create, then the retry succeeds', async() => {
    // risk: partial writes — a terminated connection used to surface as an opaque 500 (EIO) and could hang on ROLLBACK.
    await fixture.admin.query(`CREATE FUNCTION "${ fixture.schema }".terminate_me() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.path LIKE '%terminate-me%' THEN PERFORM pg_terminate_backend(pg_backend_pid()); END IF; RETURN NEW; END $$`);
    await fixture.admin.query(`CREATE TRIGGER terminate_me BEFORE INSERT ON "${ fixture.schema }".files FOR EACH ROW EXECUTE FUNCTION "${ fixture.schema }".terminate_me()`);
    const path = 'Stress/terminate-me.txt';
    const failed = await fixture.request(`/v1/fuse/files?collectionId=${ fixture.collectionId }&path=${ encodeURIComponent(path) }`, 'POST', Buffer.alloc(0), { 'content-type': 'application/octet-stream' });
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('FILES_DB_RETRYABLE');
    expect(failed.headers['retry-after']).toBe('1');
    expect(Number((await fixture.admin.query(`SELECT count(*) FROM "${ fixture.schema }".files WHERE path=$1`, [path])).rows[0].count)).toBe(0);
    await fixture.admin.query(`DROP TRIGGER terminate_me ON "${ fixture.schema }".files`);
    const retried = await fixture.createAndWrite(path, Buffer.from('saved on retry'));
    expect(await fixture.read(retried.fileId)).toBe('saved on retry');
  }, 30_000);

  it('saves sequential small files exactly, one create and one version each', async() => {
    // risk: data accuracy — every 2 KB write lands as exactly one version with the bytes sent (timing is logged for the PR).
    const times:number[] = [];
    for (let index = 0; index < 20; index++) {
      const result = await fixture.createAndWrite(`Stress/idle/f${ index }.txt`, Buffer.alloc(2048, 97 + (index % 20)));
      times.push(result.ms);
      expect(await fixture.read(result.fileId)).toBe(String.fromCharCode(97 + (index % 20)).repeat(2048));
    }
    times.sort((a, b) => a - b);
    console.info('[mount-write] idle 2 KB create+write: p50 %dms p95 %dms', Math.round(times[10]), Math.round(times[19]));
    const versions = (await fixture.pool!.query(`SELECT count(*)::int n FROM file_versions v JOIN files f ON f.id=v.file_id WHERE f.path LIKE 'Stress/idle/%'`)).rows[0].n;
    expect(versions).toBe(40);
  }, 60_000);
});
