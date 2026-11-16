// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Real-Postgres characterization of public share links (SharesService + ShareLinkRepository).
// Point SULLA_FILES_TEST_DATABASE_URL at a throwaway Postgres, e.g.
//   docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine
// Each run creates and drops its own schema and applies the real 006/010 share migrations.
// Sulla Cloud is faked at the broker boundary; everything else is the production code path.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SharesService } from '../src/shares.js';
import type { Config } from '../src/config.js';
import type { Store } from '../src/store.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const migration = (name:string) => readFileSync(new URL(`../migrations/${ name }`, import.meta.url), 'utf8');
const owner = { user: 'owner-1', device: 'device-1' };
const stranger = { user: 'owner-2', device: 'device-2' };

/** Sulla Cloud's /shares API: echoes the policy it was sent unless told to fail. */
class FakeCloud {
  calls:Array<{ path:string; method:string; body:any }> = [];
  failDelete = false;
  echoOverride:Record<string, unknown> = {};
  async execute(path:string, method = 'GET', body?:unknown):Promise<{ status:number; body:unknown }> {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    this.calls.push({ path, method, body: parsed });
    if (method === 'DELETE') return { status: this.failDelete ? 500 : 204, body: null };
    if (method === 'GET') return { status: 200, body: [] };
    return { status: 201, body: {
      url: `https://share.example/${ parsed.id ?? 'x' }`, accessMode: parsed.accessMode, passwordProtected: Boolean(parsed.password),
      passwordUpdated: parsed.password !== undefined, expiresAt: parsed.expiresAt ?? null, keepAvailable: parsed.keepAvailable,
      keepUntil: parsed.keepUntil ?? null, displaySharerName: parsed.displaySharerName, ...this.echoOverride,
    } };
  }
}

describe.skipIf(!databaseUrl)('share links (real Postgres)', () => {
  const schema = `files_shares_spec_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${ schema }`, max: 4 });
  let cloud:FakeCloud; let shares:SharesService; let collectionId = '';

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA ${ schema }`);
    await pool.query('CREATE TABLE collections(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),system_area text)');
    await pool.query(`CREATE TABLE files(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),collection_id uuid NOT NULL REFERENCES collections(id),path text NOT NULL,
      mime text NOT NULL DEFAULT 'text/plain',size bigint NOT NULL DEFAULT 1,current_version_id uuid,deleted_at timestamptz)`);
    await pool.query('CREATE TABLE files_protected_files(file_id uuid PRIMARY KEY)');
    await pool.query(migration('006_share_links.sql'));
    await pool.query(migration('010_share_controls.sql'));
  });
  afterAll(async() => { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await admin.end() });
  beforeEach(async() => {
    await pool.query('TRUNCATE file_share_events, file_share_links, files_protected_files, files, collections CASCADE');
    collectionId = (await pool.query('INSERT INTO collections DEFAULT VALUES RETURNING id')).rows[0].id;
    cloud = new FakeCloud();
    shares = new SharesService(pool, { mode: 'desktop', deviceId: 'device-1' } as Config, {} as Store, { cloudBroker: cloud });
  });

  async function seedFile(path:string, options:{ deleted?:boolean; protected?:boolean } = {}) {
    const id = (await pool.query(`INSERT INTO files(collection_id,path,current_version_id,deleted_at) VALUES($1,$2,$3,$4) RETURNING id`,
      [collectionId, path, randomUUID(), options.deleted ? new Date() : null])).rows[0].id;
    if (options.protected) await pool.query('INSERT INTO files_protected_files(file_id) VALUES($1)', [id]);
    return id as string;
  }
  const link = async(id:string) => (await pool.query('SELECT * FROM file_share_links WHERE id=$1', [id])).rows[0];
  const events = async(id:string) => (await pool.query('SELECT action,detail FROM file_share_events WHERE share_id=$1 ORDER BY occurred_at,action', [id])).rows;
  const folderShare = (extra:Record<string, unknown> = {}) => shares.create(owner, { collectionId, folderPath: 'docs', ...extra });
  async function readAll(body:AsyncIterable<Buffer>) { const parts:Buffer[] = []; for await (const part of body) parts.push(part); return Buffer.concat(parts) }

  // risk: security — a share password must be stored only as a salted hash and never returned to the owner.
  it('creates a password-protected link, stores only a salted hash and never returns secrets', async() => {
    const created:any = await folderShare({ password: 'correct horse' });
    expect(created).not.toHaveProperty('password_hash');
    expect(created).not.toHaveProperty('relay_secret');
    expect(created).toMatchObject({ owner_user_id: 'owner-1', target_type: 'folder', password_protected: true, revoked_at: null, reconciliation_required: false, public_url: `https://share.example/${ created.id }` });
    const stored = await link(created.id);
    expect(stored.password_hash).toMatch(/^[\w-]+:[\w-]+$/);
    expect(stored.password_hash).not.toContain('correct horse');
    expect(await events(created.id)).toEqual([{ action: 'created', detail: 'view access' }]);
    expect(cloud.calls[0]).toMatchObject({ path: '/shares', method: 'POST', body: { id: created.id, password: 'correct horse', accessMode: 'view' } });
  });

  // risk: security — the public access check must refuse a missing or wrong password and count only real views.
  it('authorizes public access only with the right password and counts each view', async() => {
    const created:any = await folderShare({ password: 'correct horse' });
    await expect(shares.authorize(created.id, {})).rejects.toMatchObject({ status: 401 });
    await expect(shares.authorize(created.id, { password: 'wrong horse!' })).rejects.toMatchObject({ status: 401 });
    await expect(shares.authorize(created.id, { password: 'correct horse', wantsDownload: true })).rejects.toMatchObject({ status: 403 });
    expect((await link(created.id)).view_count).toBe('0');
    expect(await shares.authorize(created.id, { password: 'correct horse' })).toMatchObject({ id: created.id, mode: 'view', targetType: 'folder' });
    expect((await link(created.id)).view_count).toBe('1');
    expect((await events(created.id)).map(event => event.action)).toContain('viewed');
  });

  // risk: security — an expired link must stop serving immediately.
  it('treats an expired link as not found for access and content', async() => {
    const created:any = await folderShare({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await pool.query("UPDATE file_share_links SET expires_at=NOW()-interval '1 second' WHERE id=$1", [created.id]);
    await expect(shares.authorize(created.id, {})).rejects.toMatchObject({ status: 404 });
    await expect(shares.streamContent(created.id, '', undefined, new AbortController().signal)).rejects.toMatchObject({ status: 404 });
  });

  // risk: data accuracy — invalid policy input must be refused before any row is written.
  it('rejects past expiry and short passwords without creating a link', async() => {
    await expect(folderShare({ expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({ status: 400 });
    await expect(folderShare({ password: 'short' })).rejects.toMatchObject({ status: 400 });
    expect((await pool.query('SELECT count(*)::int n FROM file_share_links')).rows[0].n).toBe(0);
  });

  // risk: security — a link Cloud did not confirm exactly must never become reachable.
  it('removes a new link when Cloud does not confirm its policy', async() => {
    cloud.echoOverride = { accessMode: 'download' };
    await expect(folderShare()).rejects.toMatchObject({ status: 502 });
    expect((await pool.query('SELECT count(*)::int n FROM file_share_links')).rows[0].n).toBe(0);
  });

  // risk: irreversible side effect — revoking disables local access even when the Cloud delete fails, and queues the retry.
  it('revokes a link and queues remote deletion when Cloud cannot confirm it', async() => {
    const ok:any = await folderShare();
    expect(await shares.revoke(owner, ok.id)).toEqual({ ok: true });
    expect(await link(ok.id)).toMatchObject({ reconciliation_required: false, reconciliation_action: null });
    expect((await link(ok.id)).revoked_at).not.toBeNull();
    await expect(shares.authorize(ok.id, {})).rejects.toMatchObject({ status: 404 });

    const pending:any = await folderShare();
    cloud.failDelete = true;
    await expect(shares.revoke(owner, pending.id)).rejects.toMatchObject({ status: 502 });
    expect(await link(pending.id)).toMatchObject({ reconciliation_required: true, reconciliation_action: 'delete', keep_available: false });
    expect((await link(pending.id)).revoked_at).not.toBeNull();
    expect((await events(pending.id)).map(event => event.action)).toContain('revoked');
  });

  // risk: tenant isolation — one user can never read, revoke or list another user's links.
  it('scopes owner operations to the link owner', async() => {
    const created:any = await folderShare();
    await expect(shares.get(stranger, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(shares.revoke(stranger, created.id)).rejects.toMatchObject({ status: 404 });
    expect(await shares.list(stranger)).toEqual([]);
    expect((await shares.list(owner)).map((row:any) => row.id)).toEqual([created.id]);
    expect((await link(created.id)).revoked_at).toBeNull();
  });

  // risk: security — restoring a protected link requires its password again.
  it('restores a revoked protected link only with its password', async() => {
    const created:any = await folderShare({ password: 'correct horse' });
    await shares.revoke(owner, created.id);
    await expect(shares.restore(owner, created.id, 'wrong horse!')).rejects.toMatchObject({ status: 401 });
    expect((await link(created.id)).revoked_at).not.toBeNull();
    const restored:any = await shares.restore(owner, created.id, 'correct horse');
    expect(restored.revoked_at).toBeNull();
    expect(await link(created.id)).toMatchObject({ reconciliation_required: false, served_from: 'desktop' });
  });

  // risk: data leak — a folder link lists only live, unprotected files inside that folder (LIKE wildcards escaped).
  it('streams a folder listing with byte ranges and only the folder\'s own visible files', async() => {
    await seedFile('a_b/one.md'); await seedFile('a_b/sub/two.md');
    await seedFile('a_b/secret.md', { protected: true }); await seedFile('a_b/gone.md', { deleted: true });
    await seedFile('axb/not-mine.md'); await seedFile('a_b/master.key');
    const created:any = await shares.create(owner, { collectionId, folderPath: '/a_b/' });
    const full = await shares.streamContent(created.id, '', undefined, new AbortController().signal);
    const listing = JSON.parse((await readAll(full.body)).toString());
    expect(full).toMatchObject({ status: 200, mime: 'application/json', name: 'a_b.json' });
    expect(listing.files.map((file:any) => file.path)).toEqual(['one.md', 'sub/two.md']);
    const ranged = await shares.streamContent(created.id, '', 'bytes=0-9', new AbortController().signal);
    expect(ranged).toMatchObject({ status: 206, contentLength: 10, contentRange: `bytes 0-9/${ full.contentLength }` });
    expect((await readAll(ranged.body)).toString()).toBe(JSON.stringify(listing).slice(0, 10));
    await expect(shares.streamContent(created.id, '../escape.md', undefined, new AbortController().signal)).rejects.toMatchObject({ status: 400 });
  });
});
