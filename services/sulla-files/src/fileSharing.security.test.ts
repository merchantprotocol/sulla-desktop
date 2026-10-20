import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import { createApp } from './app.js';
import { issueCapabilityToken } from './auth.js';
import { chunkId, encryptChunk } from './crypto.js';
import { migrate } from './db.js';

import type { Config } from './config.js';

const run = promisify(execFile);

test('exact-file shares enforce org membership, exact identity, roles, inheritance, and revoke', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-exact-share-'));
  const cluster = join(root, 'postgres');
  const port = 48_000 + (process.pid % 8_000);
  await run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres', '--no-locale']);
  await run('pg_ctl', ['-D', cluster, '-w', 'start', '-o', `-F -p ${ port } -h 127.0.0.1 -k ${ root }`, '-l', join(root, 'postgres.log')]);

  const admin = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ port }/postgres` });
  let db:pg.Pool | undefined;
  let server:ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
  try {
    await admin.query('CREATE DATABASE files_share_acceptance');
    const databaseUrl = `postgresql://postgres@127.0.0.1:${ port }/files_share_acceptance`;
    db = new pg.Pool({ connectionString: databaseUrl });
    await migrate(db);
    await db.query(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT NOT NULL,disabled_at TIMESTAMPTZ);
      CREATE TABLE org_members(org_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),status TEXT NOT NULL,role TEXT NOT NULL,PRIMARY KEY(org_id,user_id));
      CREATE TABLE org_groups(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,encrypted_name TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE group_members(group_id TEXT NOT NULL REFERENCES org_groups(id),user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(group_id,user_id));`);

    const orgA = 'org-a'; const orgB = 'org-b';
    const dataKey = randomBytes(32); const dedupKey = randomBytes(32);
    const users = ['owner-a', 'member-a', 'group-member-a', 'collection-member-a', 'outsider-a', 'folder-only-a', 'cross-org', 'pending-a', 'disabled-a'];
    for (const user of users) await db.query('INSERT INTO users(id,email,disabled_at) VALUES($1,$2,$3)', [user, `${ user }@example.test`, user === 'disabled-a' ? new Date() : null]);
    for (const user of ['owner-a', 'member-a', 'group-member-a', 'collection-member-a', 'outsider-a', 'folder-only-a', 'disabled-a']) await db.query("INSERT INTO org_members(org_id,user_id,status,role) VALUES($1,$2,'confirmed','member')", [orgA, user]);
    await db.query("INSERT INTO org_members(org_id,user_id,status,role) VALUES($1,'pending-a','invited','member'),($2,'cross-org','confirmed','member')", [orgA, orgB]);
    await db.query("INSERT INTO org_groups(id,org_id,encrypted_name) VALUES('design-a',$1,'Design'),('design-b',$2,'Other org')", [orgA, orgB]);
    await db.query("INSERT INTO group_members(group_id,user_id) VALUES('design-a','group-member-a'),('design-b','cross-org')");

    const collectionId = randomUUID();
    await db.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext)
      VALUES($1,$2,'owner-a','Files','knowledge','synced','{}','{}')`, [collectionId, orgA]);
    await db.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user','owner-a','manage')", [collectionId]);
    await db.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user','collection-member-a','view')", [collectionId]);
    const addFile = async(path:string) => {
      const fileId = randomUUID(); const versionId = randomUUID();
      await db!.query("INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,$3,'user','owner-a','text/plain',1)", [fileId, collectionId, path]);
      await db!.query("INSERT INTO file_versions(id,file_id,chunk_collection_id,size,created_by_type,created_by_id,device_id) VALUES($1,$2,$3,1,'user','owner-a','synthetic')", [versionId, fileId, collectionId]);
      await db!.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
      await db!.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [collectionId, fileId, versionId]);
      return { fileId, versionId, path };
    };
    const exact = await addFile('Reports/Q4.txt');
    const sibling = await addFile('Reports/Q4.txt.bak');
    const descendantCollision = await addFile('Reports/Q4.txt/child.txt');
    const groupFile = await addFile('Groups/design.txt');
    const inheritedFile = await addFile('Inherited/plan.txt');

    const signingKey = randomBytes(32);
    const config:Config = {
      keyring: { unlocked: true, keys: () => Promise.resolve({ data: dataKey, dedup: dedupKey }) } as any,
      port: 0, databaseUrl, chunkRoot: join(root, 'chunks'), dataRoot: join(root, 'data'), modelDir: join(root, 'models'),
      capabilitySigningKey: signingKey, mode: 'server', deviceId: 'synthetic-device', userId: 'owner-a', cloudUrl: 'https://invalid.test', caseInsensitiveRoot: false, paused: true,
    };
    const search = { search: (_input:unknown, scopes:unknown) => Promise.resolve(scopes) };
    server = createApp(db, config, undefined, db, search as any).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) });
    const address = server.address(); assert(address && typeof address === 'object'); const baseUrl = `http://127.0.0.1:${ address.port }`;
    const token = (userId:string) => issueCapabilityToken({ sub: userId, device_id: `${ userId }-device`, scopes: ['files/*'] }, signingKey);
    const deviceToken = (userId:string, deviceId:string) => issueCapabilityToken({ sub: userId, device_id: deviceId, scopes: ['files/*'] }, signingKey);
    const agentToken = (userId:string) => issueCapabilityToken({ sub: userId, agent_id: 'synthetic-agent', job_id: 'synthetic-run', device_id: `${ userId }-agent-device`, scopes: ['files/*'] }, signingKey);
    const request = (userId:string, path:string, init:RequestInit = {}) => fetch(`${ baseUrl }${ path }`, {
      ...init, headers: { authorization: `Bearer ${ token(userId) }`, 'content-type': 'application/json', ...init.headers },
    });
    const json = async(userId:string, path:string, init:RequestInit = {}) => {
      const response = await request(userId, path, init); return { response, body: response.status === 204 ? undefined : await response.json() };
    };
    const agentRequest = (userId:string, path:string) => fetch(`${ baseUrl }${ path }`, { headers: { authorization: `Bearer ${ agentToken(userId) }` } });

    const direct = await json('owner-a', `/v1/files/${ exact.fileId }/shares`, { method: 'POST', body: JSON.stringify({ principalType: 'user', principalId: 'member-a', role: 'view' }) });
    assert.equal(direct.response.status, 201);
    assert.equal((await request('member-a', `/v1/files/${ exact.fileId }/history`)).status, 200);
    assert.equal((await request('member-a', `/v1/versions/${ exact.versionId }`)).status, 200, 'the exact file version is readable');
    assert.equal((await request('member-a', `/v1/files/${ exact.fileId }/preview`)).status, 404, 'authorized preview reaches synthetic missing-content handling');
    assert.equal((await request('member-a', `/v1/files/${ sibling.fileId }/history`)).status, 403, 'a same-prefix sibling must not inherit exact-file access');
    assert.equal((await request('member-a', `/v1/versions/${ sibling.versionId }`)).status, 403, 'a sibling version must remain private');
    assert.equal((await request('member-a', `/v1/files/${ sibling.fileId }/preview`)).status, 403, 'a sibling preview must remain private');
    assert.equal((await request('member-a', `/v1/files/${ descendantCollision.fileId }/history`)).status, 403, 'a descendant-looking path must not inherit exact-file access');
    assert.equal((await request('member-a', `/v1/files/${ exact.fileId }/shares`)).status, 403, 'viewers cannot manage file grants');
    assert.equal((await agentRequest('member-a', `/v1/files?collectionId=${ collectionId }`)).status, 403, 'human view grants are not agent-use grants');

    const listed = await json('member-a', `/v1/files?collectionId=${ collectionId }`);
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.map((file:any) => file.id), [exact.fileId]);
    const searched = await json('member-a', '/v1/search', { method: 'POST', body: JSON.stringify({ query: 'Q4', collectionId }) });
    assert.deepEqual(searched.body, [{ collectionId, paths: [], fileIds: [exact.fileId] }]);
    await db.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user','member-a','view')", [collectionId]);
    assert.equal((await agentRequest('member-a', `/v1/files?collectionId=${ collectionId }`)).status, 403, 'a collection human-view grant still cannot open an agent listing');

    const group = await json('owner-a', `/v1/files/${ groupFile.fileId }/shares`, { method: 'POST', body: JSON.stringify({ principalType: 'group', principalId: 'design-a', role: 'view' }) });
    assert.equal(group.response.status, 201);
    assert.equal((await request('group-member-a', `/v1/files/${ groupFile.fileId }/history`)).status, 200);
    assert.equal((await request('outsider-a', `/v1/files/${ groupFile.fileId }/history`)).status, 403);
    for (const principal of [
      { principalType: 'group', principalId: 'design-b' },
      { principalType: 'user', principalId: 'cross-org' },
      { principalType: 'user', principalId: 'pending-a' },
      { principalType: 'user', principalId: 'disabled-a' },
    ]) {
      const denied = await json('owner-a', `/v1/files/${ exact.fileId }/shares`, { method: 'POST', body: JSON.stringify({ ...principal, role: 'view' }) });
      assert.equal(denied.response.status, 400, `${ principal.principalId } must not be shareable into org-a`);
    }
    await db.query("INSERT INTO file_shares(file_id,principal_type,principal_id,role,created_by) VALUES($1,'user','cross-org','view','owner-a')", [exact.fileId]);
    assert.equal((await request('cross-org', `/v1/files/${ exact.fileId }/history`)).status, 403, 'stale or malicious cross-org rows must never grant access');

    await db.query("INSERT INTO folder_shares(collection_id,folder_path,principal_type,principal_id,role,created_by) VALUES($1,'Inherited','user','outsider-a','edit','owner-a')", [collectionId]);
    await db.query("INSERT INTO folder_shares(collection_id,folder_path,principal_type,principal_id,role,created_by) VALUES($1,'Inherited','user','folder-only-a','edit','owner-a')", [collectionId]);
    await db.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user','outsider-a','view')", [collectionId]);
    assert.equal((await request('outsider-a', `/v1/files/${ inheritedFile.fileId }/history`)).status, 200, 'existing inherited folder access remains unchanged');
    const scopedAgentList = await agentRequest('outsider-a', `/v1/files?collectionId=${ collectionId }`);
    assert.equal(scopedAgentList.status, 200); assert.deepEqual((await scopedAgentList.json()).map((file:any) => file.id), [inheritedFile.fileId], 'agent lists use the effective use-by-agents threshold, not a weaker collection view grant');
    const scopedAgentJournal = await agentRequest('outsider-a', `/v1/collections/${ collectionId }/journal`);
    assert.equal(scopedAgentJournal.status, 200); assert.deepEqual((await scopedAgentJournal.json()).map((entry:any) => entry.file.id), [inheritedFile.fileId], 'agent journal filtering uses the effective requested right');

    const privatePlain = Buffer.from('private sibling chunk'); const privateChunkId = chunkId(privatePlain, dedupKey); const privateEnvelope = await encryptChunk(privatePlain, dataKey, privateChunkId);
    const privateManifest = createHash('sha256').update(JSON.stringify({ ids: [privateChunkId], size: privatePlain.length })).digest('hex');
    await db.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3)', [privateManifest, JSON.stringify([privateChunkId]), privatePlain.length]);
    await db.query('UPDATE file_versions SET manifest_hash=$2,size=$3 WHERE id=$1', [sibling.versionId, privateManifest, privatePlain.length]);
    assert.equal((await request('owner-a', `/v1/chunks/${ collectionId }/${ privateChunkId }`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Uint8Array.from(privateEnvelope) })).status, 204);
    assert.equal((await request('folder-only-a', `/v1/chunks/${ collectionId }/${ privateChunkId }`)).status, 403, 'a folder grant cannot read arbitrary sibling chunks');
    assert.equal((await request('folder-only-a', `/v1/chunks/${ collectionId }/${ randomBytes(32).toString('hex') }`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Uint8Array.from(privateEnvelope) })).status, 403, 'a folder edit grant cannot write arbitrary collection chunks');
    const access = await json('owner-a', `/v1/files/${ inheritedFile.fileId }/shares`);
    assert.equal(access.response.status, 200);
    assert.equal(access.body.ownerId, 'owner-a');
    assert.deepEqual(access.body.direct, []);
    assert.deepEqual(access.body.inherited.map((share:any) => [share.source, share.principal_id, share.folder_path ?? null]), [
      ['collection', 'collection-member-a', null],
      ['collection', 'member-a', null],
      ['collection', 'outsider-a', null],
      ['folder', 'folder-only-a', 'Inherited'],
      ['folder', 'outsider-a', 'Inherited'],
    ]);

    assert.equal((await request('member-a', `/v1/files/${ exact.fileId }`, { method: 'DELETE' })).status, 403, 'view does not permit edits');
    const changed = await json('owner-a', `/v1/files/${ exact.fileId }/shares/${ direct.body.id }`, { method: 'PATCH', body: JSON.stringify({ role: 'edit' }) });
    assert.equal(changed.response.status, 200); assert.equal(changed.body.role, 'edit');
    const agentFiles = await agentRequest('member-a', `/v1/files?collectionId=${ collectionId }`);
    assert.equal(agentFiles.status, 200); assert.deepEqual((await agentFiles.json()).map((file:any) => file.id), [exact.fileId], 'edit follows the existing role hierarchy and remains exact for agent listings');
    await db.query("DELETE FROM collection_acl WHERE collection_id=$1 AND principal_type='user' AND principal_id='member-a'", [collectionId]);
    assert.equal((await request('member-a', `/v1/chunks/${ collectionId }/not-owned-by-file`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1]) })).status, 403, 'file edit must not grant collection-wide chunk writes');
    const uploadedVersionId = randomUUID(); const uploadedPlain = Buffer.from([1, 2, 3]); const uploadedChunkId = chunkId(uploadedPlain, dedupKey); const uploadedEnvelope = await encryptChunk(uploadedPlain, dataKey, uploadedChunkId); const manifestHash = createHash('sha256').update(JSON.stringify({ ids: [uploadedChunkId], size: 3 })).digest('hex');
    const bundle = {
      collectionId,
      file: { id: exact.fileId, path: exact.path, created_by_type: 'user', created_by_id: 'member-a', mime: 'text/plain', size: 3, search_text: 'updated' },
      version: { id: uploadedVersionId, chunk_collection_id: collectionId, size: 3, deleted: false, created_by_type: 'user', created_by_id: 'member-a', message: 'exact share update' },
      baseServerVersionId: exact.versionId,
      manifest: { hash: manifestHash, chunk_ids: [uploadedChunkId], total_size: 3 },
      chunks: [{ id: uploadedChunkId, size: 3, stored_size: uploadedEnvelope.length, location: `chunks/${ collectionId }/${ uploadedChunkId }` }],
      keyContext: { collectionId, principalId: 'member-a', keyVersion: 1, epoch: 1 },
    };
    const forged = structuredClone(bundle); forged.manifest.hash = randomBytes(32).toString('hex');
    assert.equal((await json('member-a', '/v1/versions/prepare', { method: 'POST', body: JSON.stringify(forged) })).response.status, 400, 'manifest ids and size must authenticate to the supplied hash');
    const prepared = await json('member-a', '/v1/versions/prepare', { method: 'POST', body: JSON.stringify(bundle) });
    assert.equal(prepared.response.status, 200); assert.deepEqual(prepared.body.missing, [uploadedChunkId]);
    const wrongDeviceUpload = await fetch(`${ baseUrl }/v1/chunks/${ collectionId }/${ uploadedChunkId }`, { method: 'PUT', headers: { authorization: `Bearer ${ deviceToken('member-a', 'other-device') }`, 'content-type': 'application/octet-stream' }, body: Uint8Array.from(uploadedEnvelope) });
    assert.equal(wrongDeviceUpload.status, 403, 'upload intents are bound to the preparing device or agent run');
    assert.equal((await request('owner-a', `/v1/files/${ exact.fileId }/shares/${ direct.body.id }`, { method: 'DELETE' })).status, 204);
    assert.equal((await request('member-a', `/v1/chunks/${ collectionId }/${ uploadedChunkId }`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Uint8Array.from(uploadedEnvelope) })).status, 403, 'revocation invalidates an outstanding upload intent');
    const restoredEdit = await json('owner-a', `/v1/files/${ exact.fileId }/shares`, { method: 'POST', body: JSON.stringify({ principalType: 'user', principalId: 'member-a', role: 'edit' }) });
    assert.equal(restoredEdit.response.status, 201);
    assert.equal((await json('member-a', '/v1/versions/prepare', { method: 'POST', body: JSON.stringify(bundle) })).response.status, 200);
    const siblingEdit = await json('owner-a', `/v1/files/${ sibling.fileId }/shares`, { method: 'POST', body: JSON.stringify({ principalType: 'user', principalId: 'member-a', role: 'edit' }) });
    assert.equal(siblingEdit.response.status, 201);
    const siblingBundle = structuredClone(bundle); siblingBundle.file.id = sibling.fileId; siblingBundle.file.path = sibling.path; siblingBundle.version.id = randomUUID(); siblingBundle.baseServerVersionId = sibling.versionId;
    assert.equal((await json('member-a', '/v1/versions/prepare', { method: 'POST', body: JSON.stringify(siblingBundle) })).response.status, 200);
    assert.equal((await request('member-a', `/v1/chunks/${ collectionId }/${ uploadedChunkId }`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Uint8Array.from(uploadedEnvelope) })).status, 204, 'prepare authorizes only the exact version chunk after verifying its encrypted identity');
    assert.equal((await db.query('SELECT count(*)::int count FROM file_share_chunk_uploads WHERE chunk_id=$1 AND principal_id=$2 AND uploaded_at IS NOT NULL', [uploadedChunkId, 'member-a'])).rows[0].count, 2, 'one verified upload fulfills every concurrent authorized intent for the same actor and chunk');
    const committed = await json('member-a', '/v1/versions/commit', { method: 'POST', body: JSON.stringify(bundle) });
    assert.equal(committed.response.status, 200); assert.equal(committed.body.fileId, exact.fileId);
    const committedRetry = await json('member-a', '/v1/versions/commit', { method: 'POST', body: JSON.stringify(bundle) });
    assert.equal(committedRetry.response.status, 200); assert.equal(committedRetry.body.versionId, uploadedVersionId, 'a lost-response retry remains idempotent after its upload intents are consumed');
    assert.equal((await json('member-a', '/v1/versions/commit', { method: 'POST', body: JSON.stringify(siblingBundle) })).response.status, 200, 'a concurrent version sharing the chunk keeps its fulfilled intent');
    assert.equal((await request('member-a', `/v1/versions/${ uploadedVersionId }`)).status, 200, 'file editors can complete the normal version protocol');

    const ownerFileId = randomUUID(); const ownerVersionId = randomUUID(); const ownerPlain = Buffer.alloc(0); const ownerChunkId = chunkId(ownerPlain, dedupKey); const ownerEnvelope = await encryptChunk(ownerPlain, dataKey, ownerChunkId);
    const ownerManifestHash = createHash('sha256').update(JSON.stringify({ ids: [ownerChunkId], size: ownerPlain.length })).digest('hex');
    const ownerBundle = {
      collectionId,
      file: { id: ownerFileId, path: 'Owner/empty.txt', created_by_type: 'user', created_by_id: 'owner-a', mime: 'text/plain', size: ownerPlain.length, search_text: 'normal encrypted upload' },
      version: { id: ownerVersionId, chunk_collection_id: collectionId, size: ownerPlain.length, deleted: false, created_by_type: 'user', created_by_id: 'owner-a', message: 'normal owner upload' },
      baseServerVersionId: null,
      manifest: { hash: ownerManifestHash, chunk_ids: [ownerChunkId], total_size: ownerPlain.length },
      chunks: [{ id: ownerChunkId, size: ownerPlain.length, stored_size: ownerEnvelope.length, location: `chunks/${ collectionId }/${ ownerChunkId }` }],
    };
    const ownerPrepared = await json('owner-a', '/v1/versions/prepare', { method: 'POST', body: JSON.stringify(ownerBundle) });
    assert.equal(ownerPrepared.response.status, 200); assert.deepEqual(ownerPrepared.body.missing, [ownerChunkId]);
    assert.equal((await request('owner-a', `/v1/chunks/${ collectionId }/${ ownerChunkId }`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Uint8Array.from(ownerEnvelope) })).status, 204);
    const ownerCommitted = await json('owner-a', '/v1/versions/commit', { method: 'POST', body: JSON.stringify(ownerBundle) });
    assert.equal(ownerCommitted.response.status, 200); assert.equal(ownerCommitted.body.fileId, ownerFileId, 'normal encrypted zero-byte prepare/upload/commit remains functional');
    assert.equal((await request('member-a', `/v1/files/${ exact.fileId }`, { method: 'DELETE' })).status, 204, 'edit permits mutation of only the shared file');
    assert.equal((await request('owner-a', `/v1/files/${ sibling.fileId }/shares/${ siblingEdit.body.id }`, { method: 'DELETE' })).status, 204);
    assert.equal((await request('member-a', `/v1/files/${ sibling.fileId }`, { method: 'DELETE' })).status, 403);
    assert.equal((await request('owner-a', `/v1/files/${ exact.fileId }/shares/${ restoredEdit.body.id }`, { method: 'DELETE' })).status, 204);
    assert.equal((await request('member-a', `/v1/files/${ exact.fileId }/history`)).status, 403, 'revocation is immediate');
    assert.equal((await request('member-a', `/v1/versions/${ exact.versionId }`)).status, 403, 'revocation closes version reads');
    assert.equal((await request('member-a', `/v1/files/${ exact.fileId }/preview`)).status, 403, 'revocation closes preview reads');
    const revokedSearch = await json('member-a', '/v1/search', { method: 'POST', body: JSON.stringify({ query: 'Q4', collectionId }) });
    assert.deepEqual(revokedSearch.body, [], 'revocation removes the file from search scope');
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await db?.end(); await admin.end();
    await run('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
