import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import { createApp } from './app.js';
import { issueCapabilityToken } from './auth.js';
import { migrate } from './db.js';
import { FilesKeyring } from './keyring.js';
import { FileSearch } from './search.js';

import type { Config } from './config.js';

const run = promisify(execFile);

test('real handlers provision collections and preserve authenticated content across upload, versions, trash, and restore', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-functional-acceptance-'));
  const cluster = join(root, 'postgres');
  const port = 56_000 + (process.pid % 8_000);
  await run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres', '--no-locale']);
  await run('pg_ctl', ['-D', cluster, '-w', 'start', '-o', `-F -p ${ port } -h 127.0.0.1 -k ${ root }`, '-l', join(root, 'postgres.log')]);

  const admin = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ port }/postgres` });
  let db:pg.Pool | undefined;
  let server:ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
  const master = randomBytes(32);
  let keyring:FilesKeyring | undefined;
  try {
    await admin.query('CREATE DATABASE files_acceptance');
    const databaseUrl = `postgresql://postgres@127.0.0.1:${ port }/files_acceptance`;
    db = new pg.Pool({ connectionString: databaseUrl });
    await migrate(db);

    const signingKey = randomBytes(32);
    keyring = new FilesKeyring(db);
    await keyring.unlock(master, signingKey);
    const collectionId = randomUUID();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO collections
        (id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state)
        VALUES($1,'acceptance-owner','Synthetic acceptance','knowledge','desktop-only','{}','{}','native')`,
      [collectionId]);
      const wrapped = await keyring.create(collectionId, client);
      await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1', [collectionId, wrapped.data, wrapped.dedup]);
      await client.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user','acceptance-owner','manage')", [collectionId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const config:Config = {
      keyring,
      port:                 0,
      databaseUrl,
      chunkRoot:            join(root, 'chunks'),
      dataRoot:             join(root, 'data'),
      caseInsensitiveRoot:  false,
      capabilitySigningKey: signingKey,
      mode:                 'desktop',
      deviceId:             'synthetic-device',
      userId:               'acceptance-owner',
      cloudUrl:             'https://invalid.test',
      paused:               true,
      modelDir:             join(root, 'unused-model'),
    };
    const embedder = { embed: () => new Float32Array([1, 0]) };
    const search = new FileSearch(db, embedder as any);
    server = createApp(db, config, undefined, undefined, search).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) });
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${ address.port }`;
    const ownerToken = issueCapabilityToken({ sub: 'acceptance-owner', device_id: 'synthetic-device', scopes: ['files/*'] }, signingKey);
    const outsiderToken = issueCapabilityToken({ sub: 'acceptance-outsider', device_id: 'outsider-device', scopes: ['files/*'] }, signingKey);
    const agentToken = issueCapabilityToken({ sub: 'acceptance-owner', agent_id: 'acceptance-agent', job_id: 'acceptance-run', thread_id: 'acceptance-thread', device_id: 'synthetic-agent-device', scopes: ['files/*'] }, signingKey);
    const auth = { authorization: `Bearer ${ ownerToken }` };
    const requestJson = async(path:string, init:RequestInit = {}) => {
      const response = await fetch(`${ baseUrl }${ path }`, { ...init, headers: { ...auth, 'content-type': 'application/json', ...init.headers } });
      return { response, body: response.status === 204 ? undefined : await response.json() };
    };

    const unauthenticated = await fetch(`${ baseUrl }/v1/files?collectionId=${ collectionId }`);
    assert.equal(unauthenticated.status, 401);

    const ensured = await fetch(`${ baseUrl }/v1/agent-files/ensure`, {
      method: 'POST', headers: { authorization: `Bearer ${ agentToken }`, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(ensured.status, 201);
    const ensuredBody = await ensured.json();
    assert.equal((await db.query('SELECT count(*)::int AS count FROM files_collection_keys WHERE collection_id=$1', [ensuredBody.collectionId])).rows[0].count, 1);

    const firstBytes = Buffer.from('synthetic acceptance payload version one');
    const upload = await fetch(`${ baseUrl }/v1/files/upload?collectionId=${ collectionId }&path=Proof%2Facceptance.txt`, {
      method: 'PUT', headers: { ...auth, 'content-type': 'text/plain' }, body: firstBytes,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(uploaded.path, 'Proof/acceptance.txt');

    const outsider = await fetch(`${ baseUrl }/v1/files/${ uploaded.id }`, { headers: { authorization: `Bearer ${ outsiderToken }` } });
    assert.equal(outsider.status, 403);

    const listed = await requestJson(`/v1/files?collectionId=${ collectionId }&path=Proof`);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.map((file:any) => file.id), [uploaded.id]);

    const detail = await requestJson(`/v1/files/${ uploaded.id }`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.version.id, uploaded.current_version_id);
    assert.equal(detail.body.access.role, 'manage');

    const content = await fetch(`${ baseUrl }/v1/files/${ uploaded.id }/preview`, { headers: auth });
    assert.equal(content.status, 200);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), firstBytes);
    const range = await fetch(`${ baseUrl }/v1/files/${ uploaded.id }/download`, { headers: { ...auth, range: 'bytes=10-19' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), firstBytes.subarray(10, 20));

    const version = await requestJson(`/v1/versions/${ uploaded.current_version_id }`);
    assert.equal(version.response.status, 200);
    assert.equal(version.body.file.id, uploaded.id);
    assert.equal(version.body.manifest.total_size, firstBytes.length);

    await db.query("UPDATE files SET search_text='synthetic acceptance searchable proof',extraction_status='indexed',extracted_at=NOW() WHERE id=$1", [uploaded.id]);
    await db.query(`INSERT INTO file_search_chunks(file_id,version_id,ordinal,content,embedding_json)
      VALUES($1,$2,0,'synthetic acceptance searchable proof',$3)`, [uploaded.id, uploaded.current_version_id, JSON.stringify([1, 0])]);
    const searched = await requestJson('/v1/search', { method: 'POST', body: JSON.stringify({ query: 'searchable proof', collectionId }) });
    assert.equal(searched.response.status, 200);
    assert.deepEqual(searched.body.map((file:any) => file.id), [uploaded.id]);

    let starred = await requestJson('/v1/stars', { method: 'PUT', body: JSON.stringify({ collectionId, fileId: uploaded.id }) });
    assert.equal(starred.response.status, 204);
    starred = await requestJson(`/v1/stars?collectionId=${ collectionId }`);
    assert.equal(starred.response.status, 200);
    assert.deepEqual(starred.body, [{ collectionId, fileId: uploaded.id }]);

    const trashed = await requestJson(`/v1/files/${ uploaded.id }`, { method: 'DELETE' });
    assert.equal(trashed.response.status, 204);
    const activeAfterTrash = await requestJson(`/v1/files?collectionId=${ collectionId }`);
    assert.deepEqual(activeAfterTrash.body, []);
    const trash = await requestJson(`/v1/trash?collectionId=${ collectionId }`);
    assert.deepEqual(trash.body.map((file:any) => file.id), [uploaded.id]);

    const restored = await requestJson(`/v1/trash/${ uploaded.id }/restore`, { method: 'POST', body: '{}' });
    assert.equal(restored.response.status, 200);
    assert.notEqual(restored.body.versionId, uploaded.current_version_id);
    const restoredContent = await fetch(`${ baseUrl }/v1/files/${ uploaded.id }/preview`, { headers: auth });
    assert.deepEqual(Buffer.from(await restoredContent.arrayBuffer()), firstBytes);

    const history = await requestJson(`/v1/files/${ uploaded.id }/history`);
    assert.equal(history.response.status, 200);
    assert.equal(history.body.length, 3);
    assert.equal(history.body.some((item:any) => item.deleted), true);
    const originalVersion = history.body.find((item:any) => item.id === uploaded.current_version_id);
    assert(originalVersion);

    const versionRestore = await requestJson(`/v1/files/${ uploaded.id }/restore`, {
      method: 'POST', body: JSON.stringify({ versionId: originalVersion.id }),
    });
    assert.equal(versionRestore.response.status, 200);
    assert.notEqual(versionRestore.body.versionId, restored.body.versionId);
    const finalContent = await fetch(`${ baseUrl }/v1/files/${ uploaded.id }/download`, { headers: auth });
    assert.deepEqual(Buffer.from(await finalContent.arrayBuffer()), firstBytes);

    const audit = await db.query('SELECT action FROM audit_log WHERE file_id=$1 ORDER BY id', [uploaded.id]);
    assert.deepEqual(audit.rows.map(row => row.action), ['upload', 'preview', 'download', 'trash', 'trash-restore', 'preview', 'version-restore', 'download']);
    const refs = await db.query('SELECT refcount FROM chunks WHERE collection_id=$1', [collectionId]);
    assert.deepEqual(refs.rows.map(row => Number(row.refcount)), [1]);

    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    await db.query('CREATE TABLE users(id TEXT PRIMARY KEY, disabled_at TIMESTAMPTZ)');
    await db.query("CREATE TABLE org_members(org_id TEXT NOT NULL,user_id TEXT NOT NULL,status TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member')");
    await db.query("INSERT INTO users(id) VALUES('acceptance-owner')");
    await db.query("INSERT INTO org_members(org_id,user_id,status) VALUES('synthetic-org','acceptance-owner','confirmed')");
    const serverConfig:Config = { ...config, mode: 'server' };
    server = createApp(db, serverConfig, undefined, db, search).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) });
    const serverAddress = server.address();
    assert(serverAddress && typeof serverAddress === 'object');
    const defaultCollection = await fetch(`http://127.0.0.1:${ serverAddress.port }/v1/collections/default`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ orgId: 'synthetic-org' }),
    });
    assert.equal(defaultCollection.status, 201);
    const defaultBody = await defaultCollection.json();
    assert.equal(defaultBody.is_default, true);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM files_collection_keys WHERE collection_id=$1', [defaultBody.id])).rows[0].count, 1);
  } finally {
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    keyring?.close(); master.fill(0);
    await db?.end(); await admin.end();
    await run('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop']).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
