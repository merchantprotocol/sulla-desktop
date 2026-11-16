// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Files listed but unreadable (HTTP 500 / EIO) after a write whose first attempt died mid-transaction.
// Real Files routes, a real Postgres and the real chunk store; the checker is the shipped
// scale/e2e/files_fsck.mjs run as a child process. Requires SULLA_FILES_TEST_DATABASE_URL.
// FILES_SPEC_SRC=<dir> runs the same spec against another copy of src/ (used to prove the
// regression test fails on the build #1 code, a06c9c55).
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const SRC = process.env.FILES_SPEC_SRC ?? '../src';
const SERVICE_ROOT = resolve(__dirname, '..');
const FSCK = join(SERVICE_ROOT, 'scale/e2e/files_fsck.mjs');
const sha256 = (value:Buffer | string) => createHash('sha256').update(value).digest('hex');

interface Reply { status:number; body:any }
interface FsckRecord { type:string; [key:string]:any }

/** The real Files app on a real Postgres schema, driven over HTTP the way the mount drives it. */
class UnreadableVersionFixture {
  readonly schema = `files_unreadable_${ randomUUID().replaceAll('-', '') }`;
  readonly userId = 'fsck-user';
  readonly admin:Pool;
  pool?:Pool;
  root = '';
  chunkRoot = '';
  collectionId = '';
  readonly logged:string[] = [];
  private readonly signingKey = Buffer.alloc(32, 9);
  private server?:Server;
  private manager?:any;
  private baseUrl = '';
  private issueToken?:(claims:any, key:Buffer) => string;

  constructor(private readonly url:string) { this.admin = new Pool({ connectionString: url, max: 2 }) }

  get schemaUrl():string { return `${ this.url }${ this.url.includes('?') ? '&' : '?' }options=${ encodeURIComponent(`-c search_path=${ this.schema },public`) }` }

  async initialize():Promise<void> {
    const [{ migrate }, { LocalFilesManager }, { issueCapabilityToken }, { Store }] = await Promise.all([
      import(`${ SRC }/db.js`), import(`${ SRC }/localManager.js`), import(`${ SRC }/auth.js`), import(`${ SRC }/store.js`)]);
    this.issueToken = issueCapabilityToken;
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    this.pool = new Pool({ connectionString: this.url, max: 4, options: `-csearch_path=${ this.schema },public` });
    this.pool.on('error', () => undefined);
    this.pool.on('connect', client => client.on('error', () => undefined));
    await migrate(this.pool);
    try { (await import(`${ SRC }/TransactionScope.js`)).TransactionScope.guardPool(this.pool) } catch { /* build #1 had no TransactionScope */ }
    this.root = await mkdtemp(join(tmpdir(), 'sulla-unreadable-'));
    const filesRoot = join(this.root, 'files'); this.chunkRoot = join(this.root, 'chunks');
    await mkdir(filesRoot, { recursive: true }); await mkdir(this.chunkRoot, { recursive: true });
    const keyring = { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) };
    const config:any = { port: 0, databaseUrl: this.url, chunkRoot: this.chunkRoot, dataRoot: this.root, filesRoot, caseInsensitiveRoot: false,
      capabilitySigningKey: this.signingKey, mode: 'desktop', deviceId: 'local-device', userId: this.userId, localToken: 'test-local', cloudUrl: '', paused: true, modelDir: this.root,
      fuseExperiment: true, keyring, fileRoots: [{ id: 'default', name: 'Files', path: filesRoot, syncMode: 'local', paused: true, exclusions: [], primary: true }] };
    this.collectionId = randomUUID();
    await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source)
      VALUES($1,$2,'Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE)`, [this.collectionId, this.userId]);
    await this.pool.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage')", [this.collectionId, this.userId]);
    this.manager = new LocalFilesManager(this.pool, config);
    this.manager.rootCollections.set('default', this.collectionId);
    const { createApp } = await import(`${ SRC }/app.js`);
    this.server = createServer(createApp(this.pool, config, this.manager, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, new Store(this.chunkRoot)));
    await new Promise<void>(done => this.server!.listen(0, '127.0.0.1', done));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('test server did not bind');
    this.baseUrl = `http://127.0.0.1:${ address.port }`;
    // The build #1 failure: Postgres kills the writer's session in the middle of its version transaction
    // (idle-in-transaction timeout while it fsync'd chunks). Armed per test; a sequence is not rolled back.
    await this.pool.query('CREATE SEQUENCE fsck_kill_armed MINVALUE 0 START 0');
    await this.pool.query(`CREATE FUNCTION fsck_kill_writer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.message='Updated through the Files mount' AND (SELECT last_value FROM fsck_kill_armed)=1 THEN
          IF nextval('fsck_kill_armed')=2 THEN PERFORM pg_terminate_backend(pg_backend_pid()); END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await this.pool.query('CREATE TRIGGER fsck_kill_writer BEFORE INSERT ON file_versions FOR EACH ROW EXECUTE FUNCTION fsck_kill_writer()');
  }

  /** The next mount content write has its database session killed before it can commit. */
  async killNextMountWrite():Promise<void> { await this.pool!.query("SELECT setval('fsck_kill_armed',1,true)") }

  request(path:string, method:string, body?:Buffer, headers:Record<string, string> = {}):Promise<Reply> {
    const token = this.issueToken!({ sub: this.userId, device_id: 'test-device', scopes: ['files/*'], agent_id: 'fsck-agent', job_id: 'fsck-job' }, this.signingKey);
    return new Promise((done, reject) => {
      const request = httpRequest(new URL(path, this.baseUrl), { method, headers: { authorization: `Bearer ${ token }`, 'x-sulla-actor': 'fsck-agent:fsck-job', 'x-sulla-files-token': 'test-local', ...headers } }, response => {
        const parts:Buffer[] = []; response.on('data', part => parts.push(Buffer.from(part)));
        response.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let body:any = text; try { body = JSON.parse(text) } catch { /* content */ } done({ status: response.statusCode ?? 500, body }) });
      });
      request.on('error', reject); if (body) request.write(body); request.end();
    });
  }

  async create(path:string):Promise<{ fileId:string; versionId:string }> {
    const created = await this.request(`/v1/fuse/files?collectionId=${ this.collectionId }&path=${ encodeURIComponent(path) }`, 'POST', Buffer.alloc(0), { 'content-type': 'application/octet-stream' });
    if (created.status !== 201) throw new Error(`create ${ created.status } ${ JSON.stringify(created.body) }`);
    return { fileId: created.body.id, versionId: created.body.current_version_id };
  }

  write(fileId:string, ifMatch:string, base:string, content:string):Promise<Reply> {
    return this.request(`/v1/fuse/files/${ fileId }/content`, 'PUT', Buffer.from(content), { 'content-type': 'application/octet-stream', 'if-match': `"${ ifMatch }"`, 'x-sulla-source-hash': sha256(base) });
  }

  /** What the FUSE kit does: on EIO it retries the same write against the version it last saw. */
  async writeWithRetry(fileId:string, ifMatch:string, base:string, content:string):Promise<{ first:number; final:Reply }> {
    const first = await this.write(fileId, ifMatch, base, content);
    if (first.status === 200) return { first: first.status, final: first };
    return { first: first.status, final: await this.write(fileId, ifMatch, base, content) };
  }

  read(fileId:string):Promise<Reply> { return this.request(`/v1/fuse/files/${ fileId }/content`, 'GET') }

  async currentChunk(fileId:string):Promise<{ versionId:string; chunkId:string }> {
    const row = (await this.pool!.query(`SELECT v.id::text version_id,m.chunk_ids->>0 chunk_id FROM files f JOIN file_versions v ON v.id=f.current_version_id
      JOIN manifests m ON m.hash=v.manifest_hash WHERE f.id=$1`, [fileId])).rows[0];
    return { versionId: row.version_id, chunkId: row.chunk_id };
  }

  blobPath(chunkId:string):string { return join(this.chunkRoot, this.collectionId, chunkId.slice(0, 2), chunkId) }

  /** Runs the shipped checker exactly as files_fsck.py does inside the container, against this schema. */
  fsck(options:Record<string, unknown> = {}):Promise<FsckRecord[]> {
    return new Promise((done, reject) => execFile(process.execPath, ['--input-type=module', '-e', `await import(${ JSON.stringify(`file://${ FSCK }`) })`], {
      cwd: SERVICE_ROOT, env: { ...process.env, FSCK_DATABASE_URL: this.schemaUrl, FSCK_OPTS: JSON.stringify({ chunkRoot: this.chunkRoot, collectionId: this.collectionId, ...options }) }, maxBuffer: 16 << 20,
    }, (error, stdout) => {
      const records = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as FsckRecord);
      if (error && !records.length) reject(error); else done(records);
    }));
  }

  async dispose():Promise<void> {
    if (this.server) await new Promise<void>(done => this.server!.close(() => done()));
    await this.manager?.close?.(); await this.pool?.end();
    await this.admin.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`); await this.admin.end();
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}

const exists = (path:string) => access(path).then(() => true, () => false);
const problemsFor = (records:FsckRecord[], fileId:string) => records.filter(record => record.type === 'problem' && record.fileId === fileId);

describeWithDatabase('Files that are listed but unreadable (real routes, Postgres and chunk store)', () => {
  let f:UnreadableVersionFixture;
  beforeAll(async() => { f = new UnreadableVersionFixture(databaseUrl); await f.initialize() }, 60_000);
  afterAll(async() => { await f?.dispose() });

  // risk: data loss. The 136 iMac files: first write attempt died mid-transaction, the retry reported success.
  it('a write whose first attempt dies mid-transaction is readable after the retry succeeds', async() => {
    const created = await f.create('Stress/warmup/d000/f00000086.txt');
    const content = 'payload written while Postgres killed the first attempt\n'.repeat(37);
    await f.killNextMountWrite();
    const { final } = await f.writeWithRetry(created.fileId, created.versionId, '', content);
    expect(Number((await f.admin.query(`SELECT last_value FROM "${ f.schema }".fsck_kill_armed`)).rows[0].last_value)).toBe(2);
    expect(final.status, JSON.stringify(final.body)).toBe(200);
    const read = await f.read(created.fileId);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toBe(content);
  }, 30_000);

  // risk: data loss / silent corruption. Exactly the iMac state: blob on disk, its chunks row never committed.
  it('fsck finds a version whose chunk row is missing without writing anything, and --repair makes it readable losslessly', async() => {
    const created = await f.create('Stress/broken/row-missing.txt');
    const content = 'the bytes are still on disk\n'.repeat(80);
    expect((await f.write(created.fileId, created.versionId, '', content)).status).toBe(200);
    const broken = await f.currentChunk(created.fileId);
    await f.pool!.query('DELETE FROM chunks WHERE collection_id=$1 AND id=$2', [f.collectionId, broken.chunkId]);
    const errors = vi.spyOn(console, 'error').mockImplementation(line => { f.logged.push(String(line)) });
    let read:Reply;
    try { read = await f.read(created.fileId) } finally { errors.mockRestore() }
    expect(read.status).toBe(500);
    // The failed read is logged with its cause class and ids, never the content.
    const line = f.logged.find(entry => entry.includes('content read failed') && entry.includes(created.fileId));
    expect(line).toBeDefined();
    expect(line).toContain('"cause":"chunk_row_missing"');
    expect(line).toContain(broken.versionId);
    expect(line).not.toContain('still on disk');

    const before = (await f.pool!.query('SELECT (SELECT count(*) FROM chunks)::int chunks,(SELECT count(*) FROM file_versions)::int versions,(SELECT count(*) FROM audit_log)::int audits')).rows[0];
    const checked = await f.fsck({ deep: true });
    const problems = problemsFor(checked, created.fileId);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ versionId: broken.versionId, path: 'Stress/broken/row-missing.txt', failureClass: 'chunk_row_missing' });
    expect(problems[0].problems[0]).toMatchObject({ chunkId: broken.chunkId, plainBytes: content.length, repairable: true });
    expect(checked.at(-1)).toMatchObject({ type: 'summary', mode: 'read-only' });
    expect((await f.pool!.query('SELECT (SELECT count(*) FROM chunks)::int chunks,(SELECT count(*) FROM file_versions)::int versions,(SELECT count(*) FROM audit_log)::int audits')).rows[0]).toEqual(before);

    const repaired = await f.fsck({ repair: true });
    expect(repaired.filter(record => record.type === 'repair' && record.fileId === created.fileId)).toEqual([expect.objectContaining({ action: 'reregister-chunk', chunkId: broken.chunkId, refcount: 1 })]);
    const after = await f.read(created.fileId);
    expect(after.status).toBe(200);
    expect(after.body).toBe(content);
    expect(problemsFor(await f.fsck({ deep: true }), created.fileId)).toEqual([]);
    expect((await f.pool!.query("SELECT count(*)::int n FROM audit_log WHERE file_id=$1 AND action='files-fsck-repair'", [created.fileId])).rows[0].n).toBe(1);
  }, 60_000);

  // risk: data loss. Content that is really gone is reported, never deleted; rollback is opt-in and keeps history.
  it('unrecoverable content is reported, left alone by default, and only rolled back to the last readable version on request', async() => {
    const created = await f.create('Stress/broken/lost.txt');
    expect((await f.write(created.fileId, created.versionId, '', 'first readable version')).status).toBe(200);
    const good = await f.currentChunk(created.fileId);
    expect((await f.write(created.fileId, good.versionId, 'first readable version', 'second version, lost')).status).toBe(200);
    const lost = await f.currentChunk(created.fileId);
    await f.pool!.query('DELETE FROM chunks WHERE collection_id=$1 AND id=$2', [f.collectionId, lost.chunkId]);
    await rm(f.blobPath(lost.chunkId));

    const reported = problemsFor(await f.fsck(), created.fileId);
    expect(reported).toEqual([expect.objectContaining({ failureClass: 'chunk_lost', versionId: lost.versionId })]);
    const untouched = await f.fsck({ repair: true });
    expect(untouched.filter(record => record.type === 'repair' && record.fileId === created.fileId)).toEqual([expect.objectContaining({ action: 'none' })]);
    expect((await f.currentChunk(created.fileId)).versionId).toBe(lost.versionId);

    const rolled = await f.fsck({ repair: true, rollbackUnrecoverable: true });
    const action = rolled.find(record => record.type === 'repair' && record.fileId === created.fileId);
    expect(action).toMatchObject({ action: 'rollback-to-readable', restoredFromVersionId: good.versionId, brokenVersionKept: lost.versionId });
    const read = await f.read(created.fileId);
    expect(read.status).toBe(200);
    expect(read.body).toBe('first readable version');
    const history = (await f.pool!.query('SELECT id::text,parent_version_id::text,restored_from_version_id::text FROM file_versions WHERE file_id=$1 ORDER BY created_at', [created.fileId])).rows;
    expect(history.map(row => row.id)).toContain(lost.versionId);
    expect(history.at(-1)).toMatchObject({ parent_version_id: lost.versionId, restored_from_version_id: good.versionId });
  }, 60_000);

  // risk: data loss. Startup upload cleanup must not delete the only copy of a repairable file's content.
  it('stale upload cleanup keeps a blob that a version references even when its chunk row is missing', async() => {
    const created = await f.create('Stress/broken/cleanup.txt');
    expect((await f.write(created.fileId, created.versionId, '', 'kept by cleanup')).status).toBe(200);
    const broken = await f.currentChunk(created.fileId);
    await f.pool!.query('DELETE FROM chunks WHERE collection_id=$1 AND id=$2', [f.collectionId, broken.chunkId]);
    await f.pool!.query(`INSERT INTO file_upload_intents(id,collection_id,chunk_ids,updated_at) VALUES($1,$2,$3,NOW()-interval '2 hours')`,
      [randomUUID(), f.collectionId, JSON.stringify([broken.chunkId])]);
    const { cleanupStaleUploads } = await import(`${ SRC }/uploadCleanup.js`);
    const { Store } = await import(`${ SRC }/store.js`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try { expect(await cleanupStaleUploads(f.pool!, new Store(f.chunkRoot))).toBeGreaterThanOrEqual(1) } finally { warn.mockRestore() }
    expect(await exists(f.blobPath(broken.chunkId))).toBe(true);
  }, 30_000);
});
