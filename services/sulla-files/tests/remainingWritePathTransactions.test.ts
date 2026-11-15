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
import { issueCapabilityToken } from '../src/auth.js';
import { migrate } from '../src/db.js';
import { TransactionScope } from '../src/TransactionScope.js';
import { Store } from '../src/store.js';
import { LocalFilesManager } from '../src/localManager.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const sha256 = (value:Buffer | string) => createHash('sha256').update(value).digest('hex');
const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));

interface Reply { status:number; body:any; headers:Record<string, string | string[] | undefined> }

/** Boots the real Files app on a small pool, the way the mount talks to it. */
class MountWriteFixture {
  readonly schema = `files_mount_write_${ randomUUID().replaceAll('-', '') }`;
  readonly applicationName = `files-mount-write-${ randomUUID().slice(0, 8) }`;
  private readonly signingKey = Buffer.alloc(32, 9);
  readonly userId = 'mount-write-user';
  readonly admin:Pool;
  pool?:Pool;
  private server?:Server;
  private manager?:LocalFilesManager;
  private root = '';
  private baseUrl = '';
  collectionId = '';
  stageDelay=0;
  async collection(kind='knowledge',runId?:string){const id=randomUUID();await this.pool!.query("INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,agent_run_id,compatibility_state,explorer_path) VALUES($1,$2,'Target',$3,'desktop-only','{}','{}','{}',TRUE,FALSE,$4,'native',$5)",[id,this.userId,kind,runId??null,id]);return id;}

  constructor(private readonly url:string, private readonly poolMax:number) { this.admin = new Pool({ connectionString: url, max: 3 }) }

  async initialize():Promise<void> {
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    this.pool = new Pool({ connectionString: this.url, max: this.poolMax, application_name: this.applicationName, options: `-csearch_path=${ this.schema },public` });
    this.pool.on('error', () => undefined);
    this.pool.on('connect', client => client.on('error', () => undefined));
    await migrate(this.pool);
    TransactionScope.guardPool(this.pool);
    this.root = await mkdtemp(join(tmpdir(), 'sulla-mount-write-'));
    const filesRoot = join(this.root, 'files'); const chunkRoot = join(this.root, 'chunks');
    await mkdir(filesRoot, { recursive: true }); await mkdir(chunkRoot, { recursive: true });
    const keyring = { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) };
    const config:any = { port: 0, databaseUrl: this.url, chunkRoot, dataRoot: this.root, filesRoot, caseInsensitiveRoot: false,
      capabilitySigningKey: this.signingKey, mode: 'desktop', deviceId: 'local-device', userId: this.userId, localToken:'test-local', cloudUrl: '', paused: true, modelDir: this.root,
      fuseExperiment: true, keyring, fileRoots: [{ id: 'default', name: 'Files', path: filesRoot, syncMode: 'local', paused: true, exclusions: [], primary: true }] };
    this.collectionId = randomUUID();
    await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source)
      VALUES($1,$2,'Files','knowledge','desktop-only','{}','{}','{}',TRUE,FALSE)`, [this.collectionId, this.userId]);
    await this.pool.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage')", [this.collectionId, this.userId]);
    this.manager = new LocalFilesManager(this.pool, config);
    (this.manager as any).rootCollections.set('default', this.collectionId);
    const appModulePath = '../src/app.js';
    const { createApp } = await import(appModulePath);
    const fixture=this;
    class SlowStore extends Store {async put(c:string,id:string,bytes:Uint8Array){await sleep(fixture.stageDelay);return super.put(c,id,bytes)}}
    this.server = createServer(createApp(this.pool, config, this.manager,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,new SlowStore(chunkRoot)));
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('test server did not bind');
    this.baseUrl = `http://127.0.0.1:${ address.port }`;
  }

  request(path:string, method:string, body?:Buffer, headers:Record<string, string> = {}):Promise<Reply> {
    const token = issueCapabilityToken({ sub: this.userId, device_id: 'test-device', scopes: ['files/*'], agent_id: 'torture-agent', job_id: 'torture-job' }, this.signingKey);
    return new Promise((resolve, reject) => {
      const request = httpRequest(new URL(path, this.baseUrl), { method, headers: { authorization: `Bearer ${ token }`, 'x-sulla-actor': 'torture-agent:torture-job', 'x-sulla-files-token':'test-local', ...headers } }, response => {
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

describeWithDatabase('Remaining Files writers (real HTTP routes and Postgres)',()=>{
  let f:MountWriteFixture;
  beforeAll(async()=>{f=new MountWriteFixture(databaseUrl,2);await f.initialize()},60000);
  afterAll(async()=>{await f?.dispose()});
  const json=(path:string,method:string,body:any)=>f.request(path,method,Buffer.from(JSON.stringify(body)),{'content-type':'application/json'});
  const assertSlow=async(work:()=>Promise<Reply>)=>{
    f.stageDelay=3500;const watch=f.watchIdleTransactions();
    try{const reply=await work();expect(reply.status,JSON.stringify(reply.body)).toBeLessThan(300);expect(reply.status).toBeGreaterThanOrEqual(200)}
    finally{f.stageDelay=0;expect(await watch.stop()).toEqual([])}
  };
  it('empty create stages before BEGIN',async()=>{await assertSlow(()=>json('/v1/files/empty','POST',{collectionId:f.collectionId,path:'empty.txt'}))});
  it('web editor stages and merges before BEGIN',async()=>{
    const created=await f.createAndWrite('editor.txt',Buffer.from('original'));
    await assertSlow(()=>json(`/v1/files/${created.fileId}/content`,'PUT',{baseVersionId:created.versionId,content:'edited slowly'}));
    expect(await f.read(created.fileId)).toBe('edited slowly');
  });
  it.each([false,true])('keep (whole run=%s) stages before BEGIN',async(wholeRun)=>{
    const run=wholeRun?'keep-run':'keep-one';const source=await f.collection('scratch',run);const target=await f.collection();
    const created=await json('/v1/agent-files','POST',{collectionId:source,path:`${run}.txt`,content:`payload-${run}`});
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    // Source identity is assigned by the authenticated job, not request content.
    await f.pool!.query('UPDATE files SET created_by_id=$2 WHERE id=$1',[created.body.id,run]);
    await assertSlow(()=>json(wholeRun?`/v1/agent-runs/${run}/keep`:`/v1/agent-files/${created.body.id}/keep`,'POST',{collectionId:target}));
    const rows=await f.pool!.query('SELECT id FROM files WHERE collection_id=$1 AND deleted_at IS NULL',[target]);expect(rows.rowCount).toBe(1);
  });
  it('native ingest stages before BEGIN and records source atomically',async()=>{
    const target=await f.collection();const bytes=Buffer.from('native slow content');
    await assertSlow(()=>f.request(`/v1/local/native-sources/ingest?collectionId=${target}&path=native.txt`,'PUT',bytes,{
      'content-type':'text/plain','x-sulla-source-hash':sha256(bytes),'x-sulla-source-handle':'h'.repeat(43),'x-sulla-source-revision':sha256('revision-1'),'x-sulla-operation-id':randomUUID()
    }));
    expect((await f.pool!.query('SELECT count(*)::int AS count FROM files_native_sources WHERE collection_id=$1',[target])).rows[0].count).toBe(1);
  });
});
