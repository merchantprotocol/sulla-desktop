// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Shared by the route characterization specs: the real Files app (createApp) over node:http on its
// own Postgres schema with every migration applied. Specs skip unless SULLA_FILES_TEST_DATABASE_URL is set.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

import { issueCapabilityToken } from '../src/auth.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { LocalFilesManager } from '../src/localManager.js';
import { Store } from '../src/store.js';

export const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL ?? '';

export interface Reply { status:number; body:any; headers:Record<string, string | string[] | undefined> }

/** The real Files app on its own Postgres schema, driven over HTTP. */
export class FilesRoutesFixture {
  readonly schema = `files_routes_${ randomUUID().replaceAll('-', '') }`;
  readonly signingKey = Buffer.alloc(32, 7);
  readonly admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  pool!:pg.Pool;
  collectionId = randomUUID();
  unpublishedCollectionId = randomUUID();
  /** The live config the app was built with (specs flip keyring.unlocked to exercise the ready gate). */
  config:any;
  private root = '';
  private server?:Server;
  private baseUrl = '';

  /** `userId` is the owner the app starts with; pass 'desktop-user' for the pre-Vault-adoption sentinel. */
  constructor(readonly userId = 'routes-user') {}

  async start():Promise<void> {
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-csearch_path=${ this.schema },public` });
    await migrate(this.pool);
    this.root = await mkdtemp(join(tmpdir(), 'sulla-files-routes-'));
    const filesRoot = join(this.root, 'files'); const chunkRoot = join(this.root, 'chunks');
    await mkdir(filesRoot, { recursive: true }); await mkdir(chunkRoot, { recursive: true });
    const keyring = { unlocked: true, keys: async() => ({ data: Buffer.alloc(32, 1), dedup: Buffer.alloc(32, 2) }), create: async() => ({ data: {}, dedup: {} }) };
    const config:any = { port: 0, databaseUrl, chunkRoot, dataRoot: this.root, filesRoot, caseInsensitiveRoot: false,
      capabilitySigningKey: this.signingKey, mode: 'desktop', deviceId: 'local-device', userId: this.userId, localToken: 'test-local', cloudUrl: '', paused: true, modelDir: this.root,
      fuseExperiment: true, keyring, fileRoots: [{ id: 'default', name: 'Files', path: filesRoot, syncMode: 'local', paused: true, exclusions: [], primary: true }] };
    this.config = config;
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

  /** A capability token for the fixture user; pass agent ids to act as an agent run. */
  token(agent:{ agent_id?:string; job_id?:string } = {}):string { return issueCapabilityToken({ sub: this.userId, device_id: 'test-device', scopes: ['files/*'], ...agent }, this.signingKey) }

  request(path:string, method = 'GET', options:{ body?:Buffer | object; token?:string | null; headers?:Record<string, string> } = {}):Promise<Reply> {
    const token = options.token === undefined ? this.token() : options.token;
    const json = options.body && !Buffer.isBuffer(options.body);
    const payload = json ? Buffer.from(JSON.stringify(options.body)) : options.body as Buffer | undefined;
    const headers:Record<string, string> = { 'x-sulla-files-token': 'test-local', ...(token ? { authorization: `Bearer ${ token }` } : {}), ...(json ? { 'content-type': 'application/json' } : {}),
      // node:http does not frame a DELETE body by default; without content-length the server never sees it.
      ...(payload ? { 'content-length': String(payload.length) } : {}), ...options.headers };
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
