import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from './app.js';
import { issueCapabilityToken } from '../../../pkg/rancher-desktop/runtime/capabilityToken.js';

const signingKey = 'sulla-files-test-signing-key-32-bytes!';
const token = issueCapabilityToken({ sub: 'user-1', device_id: 'device-1', scopes: ['files/*'] }, signingKey);

function fakeDb() {
  const pool = {
    query(sql:string, params:any[] = []) {
      if (sql.includes('INSERT INTO collections')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (sql.includes('FROM collection_acl') && params[0] === 'collection-a') return Promise.resolve({ rows: [{ role: 'edit' }], rowCount: 1 });
      if (sql.includes('FROM collection_acl')) return Promise.resolve({ rows: [], rowCount: 0 });
      if (sql.includes('SELECT collection_id,current_version_id FROM files') && params[0] === 'foreign-file') return Promise.resolve({ rows: [{ collection_id: 'collection-b', current_version_id: null }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    connect() { return Promise.resolve({ query: (sql:string, params:any[] = []) => sql.includes('SELECT collection_id,current_version_id FROM files') && params[0] === 'foreign-file' ? Promise.resolve({ rows: [{ collection_id: 'collection-b', current_version_id: null }], rowCount: 1 }) : Promise.resolve({ rows: [], rowCount: 0 }), release() {} }) },
  };
  return pool as any;
}

async function withServer(fn:(baseUrl:string) => Promise<void>) {
  const server = createApp(fakeDb(), { chunkRoot: '/tmp/sulla-files-security-test', databaseUrl: '', port: 0, capabilitySigningKey: signingKey }).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${ (server.address() as any).port }`) } finally { server.close() }
}

test('files server rejects spoofed identity, collection takeover, and cross-collection commits', async() => {
  await withServer(async baseUrl => {
    const spoofed = await fetch(`${ baseUrl }/v1/collections`, { headers: { 'x-sulla-user-id': 'user-1' } });
    assert.equal(spoofed.status, 401);

    const recreate = await fetch(`${ baseUrl }/v1/collections`, { method: 'POST', headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json' }, body: JSON.stringify({ collection: { id: 'collection-a', kind: 'knowledge' } }) });
    assert.equal(recreate.status, 409);

    const foreignFile = await fetch(`${ baseUrl }/v1/versions/commit`, { method: 'POST', headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json' }, body: JSON.stringify({ collectionId: 'collection-a', file: { id: 'foreign-file' }, version: { id: 'version-1', chunk_collection_id: 'collection-a' }, manifest: { hash: 'hash', chunk_ids: [] } }) });
    assert.equal(foreignFile.status, 403);

    const foreignChunks = await fetch(`${ baseUrl }/v1/versions/commit`, { method: 'POST', headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json' }, body: JSON.stringify({ collectionId: 'collection-a', file: { id: 'new-file' }, version: { id: 'version-2', chunk_collection_id: 'collection-b' }, manifest: { hash: 'hash-2', chunk_ids: [] } }) });
    assert.equal(foreignChunks.status, 403);
  });
});
