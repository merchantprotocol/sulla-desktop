// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the route groups moved out of app.ts (FileListingRoutes, ShareRoutes) and the
// FilesAccessGate / FileAccessRepository / FileListingRepository they use: the real Files app over
// node:http on a real Postgres schema with every migration applied. Requires SULLA_FILES_TEST_DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { issueCapabilityToken } from '../src/auth.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { FileListingQuery } from '../src/FileListingQuery.js';
import { LocalFilesManager } from '../src/localManager.js';
import { FileAccessRepository } from '../src/Repositories/FileAccessRepository.js';
import { FileListingRepository } from '../src/Repositories/FileListingRepository.js';
import { Store } from '../src/store.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL ?? '';

interface Reply { status:number; body:any; headers:Record<string, string | string[] | undefined> }

/** The real Files app on its own Postgres schema, driven over HTTP. */
class FilesRoutesFixture {
  readonly schema = `files_routes_${ randomUUID().replaceAll('-', '') }`;
  readonly userId = 'routes-user';
  readonly signingKey = Buffer.alloc(32, 7);
  readonly admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  pool!:pg.Pool;
  collectionId = randomUUID();
  unpublishedCollectionId = randomUUID();
  private root = '';
  private server?:Server;
  private baseUrl = '';

  async start():Promise<void> {
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${ this.schema },public` });
    await migrate(this.pool);
    this.root = await mkdtemp(join(tmpdir(), 'sulla-files-routes-'));
    const filesRoot = join(this.root, 'files'); const chunkRoot = join(this.root, 'chunks');
    await mkdir(filesRoot, { recursive: true }); await mkdir(chunkRoot, { recursive: true });
    const keyring = { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }) };
    const config:any = { port: 0, databaseUrl, chunkRoot, dataRoot: this.root, filesRoot, caseInsensitiveRoot: false,
      capabilitySigningKey: this.signingKey, mode: 'desktop', deviceId: 'local-device', userId: this.userId, localToken: 'test-local', cloudUrl: '', paused: true, modelDir: this.root,
      fuseExperiment: true, keyring, fileRoots: [{ id: 'default', name: 'Files', path: filesRoot, syncMode: 'local', paused: true, exclusions: [], primary: true }] };
    for (const [id, published] of [[this.collectionId, true], [this.unpublishedCollectionId, false]] as const) {
      // Each collection of one owner needs its own explorer_path (unique per owner/org).
      await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,explorer_path)
        VALUES($1,$2,'Files','knowledge','desktop-only','{}','{}','{}',$3,FALSE,$4)`, [id, this.userId, published, `spec-${ id }`]);
    }
    const manager = new LocalFilesManager(this.pool, config);
    manager.rootCollections.set('default', this.collectionId);
    this.server = createServer(createApp(this.pool, config, manager, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, new Store(chunkRoot)));
    await new Promise<void>(done => this.server!.listen(0, '127.0.0.1', done));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('test server did not bind');
    this.baseUrl = `http://127.0.0.1:${ address.port }`;
  }

  async stop():Promise<void> {
    await new Promise(done => this.server ? this.server.close(done) : done(undefined));
    await this.pool?.end();
    await this.admin.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`); await this.admin.end();
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }

  request(path:string, method = 'GET', options:{ body?:Buffer | object; token?:string | null; headers?:Record<string, string> } = {}):Promise<Reply> {
    const token = options.token === undefined ? issueCapabilityToken({ sub: this.userId, device_id: 'test-device', scopes: ['files/*'] }, this.signingKey) : options.token;
    const json = options.body && !Buffer.isBuffer(options.body);
    const payload = json ? Buffer.from(JSON.stringify(options.body)) : options.body as Buffer | undefined;
    const headers:Record<string, string> = { 'x-sulla-files-token': 'test-local', ...(token ? { authorization: `Bearer ${ token }` } : {}), ...(json ? { 'content-type': 'application/json' } : {}), ...options.headers };
    return new Promise((done, reject) => {
      const request = httpRequest(new URL(path, this.baseUrl), { method, headers }, response => {
        const parts:Buffer[] = []; response.on('data', part => parts.push(Buffer.from(part)));
        response.on('end', () => { const text = Buffer.concat(parts).toString('utf8'); let body:any = text; try { body = JSON.parse(text) } catch { /* not JSON */ } done({ status: response.statusCode ?? 500, body, headers: response.headers }) });
      });
      request.on('error', reject); if (payload) request.write(payload); request.end();
    });
  }

  async createFile(path:string):Promise<string> {
    const created = await this.request(`/v1/fuse/files?collectionId=${ this.collectionId }&path=${ encodeURIComponent(path) }`, 'POST', { body: Buffer.from(`body of ${ path }`), headers: { 'content-type': 'application/octet-stream' } });
    if (created.status !== 201) throw new Error(`create ${ path }: ${ created.status } ${ JSON.stringify(created.body) }`);
    return created.body.id;
  }

  async insertLink(owner:string, fileId:string, accessMode:'view' | 'download'):Promise<string> {
    const id = randomBytes(12).toString('base64url');
    await this.pool.query(`INSERT INTO file_share_links(id,owner_user_id,target_type,file_id,display_name,mime,access_mode,served_from,password_hash)
      VALUES($1,$2,'file',$3,'one.txt','text/plain',$4,'desktop','secret-hash')`, [id, owner, fileId, accessMode]);
    return id;
  }
}

describe.skipIf(!databaseUrl)('Files listing and share routes (real app, real Postgres)', () => {
  const fixture = new FilesRoutesFixture();
  const files:Record<string, string> = {};

  beforeAll(async() => {
    await fixture.start();
    for (const path of ['a/one.txt', 'a/two.txt', 'a/sub/four.txt', 'b/three.txt']) files[path] = await fixture.createFile(path);
  }, 30_000);
  afterAll(() => fixture.stop());

  const list = (query:string) => fixture.request(`/v1/files?collectionId=${ fixture.collectionId }&${ query }`);

  it('refuses unauthenticated, unscoped and unknown-collection listings', async() => {
    // risk: permissions — the auth middleware must still run before the moved listing route.
    expect(await fixture.request(`/v1/files?collectionId=${ fixture.collectionId }`, 'GET', { token: null })).toMatchObject({ status: 401, body: { error: 'unauthorized' } });
    expect(await fixture.request('/v1/files')).toMatchObject({ status: 400, body: { error: 'collectionId is required' } });
    expect((await fixture.request(`/v1/files?collectionId=${ fixture.unpublishedCollectionId }`)).status).toBe(404);
    expect(await list('path=a&limit=1&cursor=!!!')).toMatchObject({ status: 400, body: { error: 'invalid listing cursor' } });
  });

  it('lists a folder\'s direct children or its whole subtree, with version and capabilities', async() => {
    // risk: data accuracy — a listing that leaks siblings (b/) or drops nested files corrupts the mount view.
    const children = await list('path=a&children=true');
    expect(children.status).toBe(200);
    expect(children.body.map((row:any) => row.path)).toEqual(['a/one.txt', 'a/two.txt']);
    expect(children.body[0]).toMatchObject({ id: files['a/one.txt'], collection_id: fixture.collectionId, current_version_id: expect.any(String), capabilities: expect.any(Object) });
    expect(children.body[0].search_text).toBeUndefined();
    expect((await list('path=a')).body.map((row:any) => row.path)).toEqual(['a/one.txt', 'a/sub/four.txt', 'a/two.txt']);
  });

  it('pages with a keyset cursor until X-Has-More is false', async() => {
    // risk: data accuracy — a skipped or repeated row across pages loses files during sync.
    const first = await list('path=a&limit=2');
    expect(first.body.map((row:any) => row.path)).toEqual(['a/one.txt', 'a/sub/four.txt']);
    expect(first.headers['x-has-more']).toBe('true');
    const second = await list(`path=a&limit=2&cursor=${ first.headers['x-next-cursor'] }`);
    expect(second.body.map((row:any) => row.path)).toEqual(['a/two.txt']);
    expect(second.headers['x-has-more']).toBe('false');
  });

  it('lists only owned links, never their password hash, and authorizes by link policy', async() => {
    // risk: permissions — another owner's links or password hashes must never be returned.
    const own = await fixture.insertLink(fixture.userId, files['a/one.txt'], 'view');
    await fixture.insertLink('someone-else', files['a/two.txt'], 'download');
    const links = await fixture.request('/v1/links');
    expect(links.status).toBe(200);
    expect(links.body.map((row:any) => row.id)).toEqual([own]);
    expect(links.body[0].password_hash).toBeUndefined();
    expect((await fixture.request(`/v1/local/shares/${ own }/authorize`, 'POST', { body: { download: true } })).status).toBe(403);
    expect(await fixture.request(`/v1/local/shares/${ own }/authorize`, 'POST', { body: {} })).toMatchObject({ status: 200, body: { id: own, mode: 'view', targetType: 'file' } });
    expect((await fixture.pool.query('SELECT view_count FROM file_share_links WHERE id=$1', [own])).rows[0].view_count).toBe('1');
    expect((await fixture.request('/v1/local/shares/missing/authorize', 'POST', { body: {} })).status).toBe(404);
  });

  it('checks file and folder access before creating a link', async() => {
    // risk: permissions — a link for an unknown file or an invalid folder path must be refused before any row is written.
    expect((await fixture.request('/v1/links', 'POST', { body: { fileId: randomUUID() } })).status).toBe(404);
    expect(await fixture.request('/v1/links', 'POST', { body: { collectionId: fixture.collectionId, folderPath: '../escape' } })).toMatchObject({ status: 400, body: { error: 'invalid Files path' } });
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM file_share_links WHERE owner_user_id=$1', [fixture.userId])).rows[0].n).toBe(1);
  });

  it('repositories read published collections and files by id only', async() => {
    // risk: data accuracy — an unpublished collection must not resolve for access checks.
    const records = new FileAccessRepository(fixture.pool);
    expect((await records.publishedCollection(fixture.collectionId))?.id).toBe(fixture.collectionId);
    expect(await records.publishedCollection(fixture.unpublishedCollectionId)).toBeUndefined();
    expect((await records.file(files['b/three.txt']))?.path).toBe('b/three.txt');
    expect(await records.file(randomUUID())).toBeUndefined();
    const listings = new FileListingRepository(fixture.pool, 'f.id,f.path');
    const scope = new FileListingQuery().build({ collectionId: fixture.collectionId, path: 'b', childrenOnly: true, trash: false, after: '', limit: 10 });
    expect((await listings.page(scope)).map(row => row.path)).toEqual(['b/three.txt']);
    await expect(listings.page({ ...scope, orderLimit: 'ORDER BY f.path' })).rejects.toThrow(/row limit/);
  });
});
