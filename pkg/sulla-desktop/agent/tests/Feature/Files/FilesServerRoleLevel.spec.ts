// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Sulla Server (sulla-files mode=server): an organization member is mapped to
// the `view` level (acl.ts organizationCollectionRole). These specs drive the
// real Express app through HTTP with a real Postgres schema and a fake
// accounts service, and prove a view-level member cannot change files while
// an admin still can. PERMISSIONS-DESIGN-DRAFT §1.6 bug 1.

import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';

import { migrate } from '../../../../../../services/sulla-files/src/db.js';

vi.mock('@aws-sdk/client-s3', () => ({ S3Client:class {}, PutObjectCommand:class {}, GetObjectCommand:class {}, HeadObjectCommand:class {}, DeleteObjectCommand:class {}, ListObjectsV2Command:class {} }));
vi.mock('@sulla/vault-crypto', () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface HttpResult { status:number; body:any }

/** Stands in for sulla-accounts: resolves a UI session token to an org identity with roles. */
class FakeAccountsService {
  private server?:Server;
  url = '';
  constructor(private readonly sessions:Map<string, { subject:string; roles:string[] }>, private readonly organizationId:string) {}

  async start():Promise<void> {
    this.server = createServer((request, response) => {
      const chunks:Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const { token } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const session = this.sessions.get(token);
        if (request.url !== '/v1/private/ui-sessions/resolve' || !session) { response.statusCode = 401; response.end('{}'); return }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ issuer:'https://idp.test', subject:session.subject, authorityId:'authority-1', organizationId:this.organizationId,
          audience:'sulla-files', expiresAt:new Date(Date.now() + 3_600_000).toISOString(), roles:session.roles, groups:[] }));
      });
    });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('accounts fake did not bind');
    this.url = `http://127.0.0.1:${ address.port }`;
  }

  async stop():Promise<void> { if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve())) }
}

class ServerModeFilesFixture {
  private readonly schema = `files_role_level_${ randomUUID().replaceAll('-', '') }`;
  private readonly organizationId = 'org-role-level';
  private readonly admin:Pool;
  private readonly accounts:FakeAccountsService;
  private pool?:Pool;
  private server?:Server;
  private baseUrl = '';
  private root = '';
  collectionId = '';

  constructor(private readonly url:string) {
    this.admin = new Pool({ connectionString:url });
    this.accounts = new FakeAccountsService(new Map([
      ['admin-session', { subject:'admin-subject', roles:['admin'] }],
      ['member-session', { subject:'member-subject', roles:['member'] }],
    ]), this.organizationId);
  }

  async initialize():Promise<void> {
    await this.admin.query(`CREATE SCHEMA "${ this.schema }"`);
    this.pool = new Pool({ connectionString:this.url, options:`-csearch_path=${ this.schema },public` });
    await migrate(this.pool);
    // Identity tables live in the accounts-backed identity database on a real server.
    await this.pool.query(`
      CREATE TABLE users(id TEXT PRIMARY KEY, disabled_at TIMESTAMPTZ);
      CREATE TABLE accounts_identities(issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id));
      CREATE TABLE org_members(org_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL);
      INSERT INTO users(id) VALUES('admin-user'),('member-user');
      INSERT INTO accounts_identities(issuer,subject,user_id) VALUES('https://idp.test','admin-subject','admin-user'),('https://idp.test','member-subject','member-user');
    `);
    await this.pool.query("INSERT INTO org_members(org_id,user_id,status) VALUES($1,'admin-user','confirmed'),($1,'member-user','confirmed')", [this.organizationId]);
    await this.accounts.start();
    this.root = await mkdtemp(join(tmpdir(), 'sulla-files-role-level-'));
    const chunkRoot = join(this.root, 'chunks'); await mkdir(chunkRoot, { recursive:true });
    const keyring = { unlocked:true, keys:async() => ({ data:Buffer.alloc(32, 1), dedup:Buffer.alloc(32, 2) }) };
    const config:any = { port:0, databaseUrl:this.url, chunkRoot, dataRoot:this.root, caseInsensitiveRoot:false, capabilitySigningKey:Buffer.alloc(32, 9),
      accounts:{ url:this.accounts.url, serviceToken:'service-token', audience:'sulla-files' }, mode:'server', deviceId:'server', userId:'server',
      orgId:this.organizationId, cloudUrl:'', paused:true, modelDir:this.root, keyring, fileRoots:[] };
    this.collectionId = randomUUID();
    await this.pool.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,published,legacy_source,workspace_scope)
      VALUES($1,$2,'admin-user','Org Files','knowledge','synced','{}','{}','{}',TRUE,FALSE,'organization')`, [this.collectionId, this.organizationId]);
    const appModulePath = '../../../../../../services/sulla-files/src/app.js';
    const { createApp } = await import(appModulePath);
    this.server = createServer(createApp(this.pool, config, undefined, this.pool));
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('files server did not bind');
    this.baseUrl = `http://127.0.0.1:${ address.port }`;
  }

  async request(session:string, method:string, path:string, body?:string | Buffer, contentType = 'application/json'):Promise<HttpResult> {
    const url = new URL(path, this.baseUrl);
    return new Promise<HttpResult>((resolve, reject) => {
      const headers:Record<string, string> = { authorization:`Bearer ${ session }` };
      if (body !== undefined) headers['content-type'] = contentType;
      const outgoing = httpRequest(url, { method, headers }, response => {
        const chunks:Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8'); let parsed:any = text;
          try { parsed = text ? JSON.parse(text) : {} } catch { /* non-JSON body */ }
          resolve({ status:response.statusCode ?? 500, body:parsed });
        });
      });
      outgoing.on('error', reject); if (body !== undefined) outgoing.write(body); outgoing.end();
    });
  }

  upload(session:string, path:string, text:string):Promise<HttpResult> {
    return this.request(session, 'PUT', `/v1/files/upload?collectionId=${ this.collectionId }&path=${ encodeURIComponent(path) }`, Buffer.from(text), 'text/plain');
  }

  async adminFile(path:string):Promise<{ id:string; current_version_id:string }> {
    const created = await this.upload('admin-session', path, 'original text');
    if (created.status !== 201) throw new Error(`admin seed upload failed: ${ created.status } ${ JSON.stringify(created.body) }`);
    return created.body;
  }

  async row(fileId:string):Promise<{ path:string; current_version_id:string; deleted_at:Date | null }> {
    return (await this.pool!.query('SELECT path,current_version_id,deleted_at FROM files WHERE id=$1', [fileId])).rows[0];
  }

  async fileCount(path:string):Promise<number> {
    return Number((await this.pool!.query('SELECT COUNT(*) AS count FROM files WHERE collection_id=$1 AND path=$2', [this.collectionId, path])).rows[0].count);
  }

  async dispose():Promise<void> {
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    await this.accounts.stop(); await this.pool?.end();
    await this.admin.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`); await this.admin.end();
    if (this.root) await rm(this.root, { recursive:true, force:true });
  }
}

const databaseUrl = process.env.SULLA_TEST_DATABASE_URL ?? '';
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('Sulla Server Files: a view-level org member cannot change files', () => {
  const fixture = new ServerModeFilesFixture(databaseUrl);
  beforeAll(() => fixture.initialize(), 120_000);
  afterAll(() => fixture.dispose());

  it('lets an org admin upload and a member read it', async() => {
    // risk: availability — the level check must not lock admins out or hide files from members.
    const file = await fixture.adminFile('Team/readable.txt');
    const read = await fixture.request('member-session', 'GET', `/v1/files/${ file.id }`);
    expect(read.status).toBe(200);
  });

  it('refuses a member upload of a new file', async() => {
    // risk: permissions — a view-level member must not create files in an org collection.
    const result = await fixture.upload('member-session', 'Team/member-new.txt', 'member text');
    expect(result.status).toBe(403);
    expect(await fixture.fileCount('Team/member-new.txt')).toBe(0);
  });

  it('refuses a member overwrite of an existing file', async() => {
    // risk: permissions/data integrity — a view-level member must not replace an admin's content.
    const file = await fixture.adminFile('Team/overwrite.txt');
    const result = await fixture.upload('member-session', 'Team/overwrite.txt', 'member overwrite');
    expect(result.status).toBe(403);
    expect((await fixture.row(file.id)).current_version_id).toBe(file.current_version_id);
  });

  it('refuses a member text save through the version-checked content route', async() => {
    // risk: permissions/data integrity — requireFile(...,'edit') must enforce the level.
    const file = await fixture.adminFile('Team/content.txt');
    const result = await fixture.request('member-session', 'PUT', `/v1/files/${ file.id }/content`, JSON.stringify({ baseVersionId:file.current_version_id, content:'member edit' }));
    expect(result.status).toBe(403);
    expect((await fixture.row(file.id)).current_version_id).toBe(file.current_version_id);
  });

  it('refuses a member move of a file', async() => {
    // risk: permissions — a view-level member must not move (rename) files.
    const file = await fixture.adminFile('Team/move-me.txt');
    const result = await fixture.request('member-session', 'POST', '/v1/file-operations', JSON.stringify({ action:'move', collectionId:fixture.collectionId, items:[{ fileId:file.id, targetPath:'Team/moved.txt' }] }));
    expect(result.status).toBe(403);
    expect((await fixture.row(file.id)).path).toBe('Team/move-me.txt');
  });

  it('refuses a member delete of a file', async() => {
    // risk: irreversible side effect — a view-level member must not trash files.
    const file = await fixture.adminFile('Team/delete-me.txt');
    const result = await fixture.request('member-session', 'DELETE', `/v1/files/${ file.id }`);
    expect(result.status).toBe(403);
    expect((await fixture.row(file.id)).deleted_at).toBeNull();
  });

  it('lets an org admin move and delete', async() => {
    // risk: availability — the fix must keep manage-level callers working.
    const moved = await fixture.adminFile('Team/admin-move.txt');
    const move = await fixture.request('admin-session', 'POST', '/v1/file-operations', JSON.stringify({ action:'move', collectionId:fixture.collectionId, items:[{ fileId:moved.id, targetPath:'Team/admin-moved.txt' }] }));
    expect(move.status).toBe(200);
    expect((await fixture.row(moved.id)).path).toBe('Team/admin-moved.txt');
    const trashed = await fixture.adminFile('Team/admin-delete.txt');
    const remove = await fixture.request('admin-session', 'DELETE', `/v1/files/${ trashed.id }`);
    expect(remove.status).toBe(204);
    expect((await fixture.row(trashed.id)).deleted_at).not.toBeNull();
  });
});
