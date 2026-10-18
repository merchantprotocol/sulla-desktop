import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from './app.js';
import { issueCapabilityToken } from './auth.js';

const signingKey = 'sulla-files-integrity-test-key-32b';
const ownerId = 'owner-1';
const collectionId = '11111111-1111-4111-8111-111111111111';
const fileId = '22222222-2222-4222-8222-222222222222';
const currentVersionId = '33333333-3333-4333-8333-333333333333';
const newVersionId = '44444444-4444-4444-8444-444444444444';
const token = issueCapabilityToken({ sub: ownerId, device_id: 'device-1', scopes: ['files/*'] }, signingKey);

function fakeDb() {
  const mutations:string[] = [];
  const query = (sql:string, params:any[] = []) => {
    if (/^(?:INSERT|UPDATE|DELETE)/.test(sql)) mutations.push(sql);
    if (sql === 'SELECT * FROM collections WHERE id=$1 AND published=TRUE AND legacy_source=FALSE') {
      return { rows: [{ id: collectionId, owner_user_id: ownerId, published: true, legacy_source: false }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT id,collection_id,current_version_id FROM files')) {
      return { rows: [{ id: fileId, collection_id: collectionId, current_version_id: currentVersionId }], rowCount: 1 };
    }
    if (sql === 'SELECT file_id,chunk_collection_id,manifest_hash,size,deleted FROM file_versions WHERE id=$1') {
      return params[0] === currentVersionId
        ? { rows: [{ file_id: fileId, chunk_collection_id: collectionId, manifest_hash: null, size: 3, deleted: false }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql === 'SELECT collection_id,principal_id,key_version,key_epoch FROM file_version_key_contexts WHERE version_id=$1') {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release() {} };

  return { db: { query, connect: () => client } as any, mutations };
}

async function withServer(db:any, fn:(baseUrl:string) => Promise<void>) {
  const app = createApp(db, {
    keyring:              { unlocked: true } as any,
    chunkRoot:            '/tmp/sulla-files-data-integrity-test',
    dataRoot:             '/tmp/sulla-files-data-integrity-test',
    modelDir:             '/tmp/sulla-files-data-integrity-test',
    databaseUrl:          '',
    port:                 0,
    capabilitySigningKey: signingKey,
    localToken:           'local-test-token',
    mode:                 'server',
    deviceId:             'test',
    userId:               ownerId,
    cloudUrl:             'https://cloud.invalid',
    caseInsensitiveRoot:  false,
    paused:               false,
  }).listen(0);
  await new Promise<void>(resolve => app.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${ (app.address() as any).port }`) } finally { app.close() }
}

test('remote commit replay is mutation-free and a null base cannot overwrite an existing version', async() => {
  const { db, mutations } = fakeDb();
  const request = (baseUrl:string, versionId:string) => fetch(`${ baseUrl }/v1/versions/commit`, {
    method:  'POST',
    headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json' },
    body:    JSON.stringify({
      collectionId,
      file:                { id: fileId, path: 'Reports/result.txt', created_by_type: 'user', created_by_id: ownerId, mime: 'text/plain', size: 3, search_text: '' },
      version:             { id: versionId, chunk_collection_id: collectionId, size: 3, deleted: false, created_by_type: 'user', created_by_id: ownerId, message: 'sync' },
      baseServerVersionId: null,
      chunks:              [],
    }),
  });

  await withServer(db, async baseUrl => {
    const replay = await request(baseUrl, currentVersionId);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: true, versionId: currentVersionId, fileId });
    assert.deepEqual(mutations, [], 'an exact replay must not duplicate refcounts, versions, file updates, or journal entries');

    const stale = await request(baseUrl, newVersionId);
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { conflict: true, currentVersionId });
    assert.deepEqual(mutations, [], 'a null-base stale write must be rejected before durable mutations');
  });
});
