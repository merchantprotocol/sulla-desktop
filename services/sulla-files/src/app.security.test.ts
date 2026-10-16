import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from './app.js';
import { issueCapabilityToken } from './auth.js';

const signingKey = 'sulla-files-test-signing-key-32-bytes!';
const memberToken = issueCapabilityToken({ sub: 'member-1', device_id: 'member-device', scopes: ['files/*'] }, signingKey);
const outsiderToken = issueCapabilityToken({ sub: 'outsider-1', device_id: 'outsider-device', scopes: ['files/*'] }, signingKey);

function fakeDb() {
  return {
    query(sql:string, params:any[] = []) {
      if (sql === 'SELECT * FROM collections WHERE id=$1') return { rows: [{ id: 'collection-a', org_id: 'org-a', owner_user_id: 'owner-1', kind: 'knowledge' }], rowCount: 1 };
      if (sql.startsWith('SELECT role FROM collection_acl')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT folder_path,role FROM folder_shares')) return { rows: params[1] === 'member-1' ? [{ folder_path: 'Team', role: 'view' }] : [], rowCount: params[1] === 'member-1' ? 1 : 0 };
      if (sql === 'SELECT * FROM files WHERE id=$1') return { rows: [{ id: params[0], collection_id: 'collection-a', path: 'Private/plan.md', current_version_id: 'version-private' }], rowCount: 1 };
      if (sql.includes('FROM journal j')) {
        assert.deepEqual(params[2], ['Team'], 'sync feed must be constrained to the shared folder');
        return { rows: [{ seq: 9, file: { id: 'team-file', collection_id: 'collection-a', path: 'Team/notes.md' }, version: { id: 'team-version', device_id: 'owner-device' }, manifest: { hash: 'manifest', chunk_ids: [] } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

async function withServer(fn:(baseUrl:string) => Promise<void>) {
  const server = createApp(fakeDb(), { chunkRoot: '/tmp/sulla-files-sharing-test', dataRoot: '/tmp/sulla-files-sharing-test', databaseUrl: '', port: 0, capabilitySigningKey: signingKey, localToken: 'local-test-token', mode: 'server', deviceId: 'test', userId: 'owner-1', cloudUrl: 'https://cloud.invalid', paused: false }).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { await fn(`http://127.0.0.1:${ (server.address() as any).port }`) } finally { server.close() }
}

test('folder ACL denies unrelated org members and paths outside the grant', async() => {
  await withServer(async baseUrl => {
    const outsideOrg = await fetch(`${ baseUrl }/v1/files/private-file`, { headers: { authorization: `Bearer ${ outsiderToken }` } });
    assert.equal(outsideOrg.status, 403);
    const outsideFolder = await fetch(`${ baseUrl }/v1/files/private-file`, { headers: { authorization: `Bearer ${ memberToken }` } });
    assert.equal(outsideFolder.status, 403);
  });
});

test('shared-folder sync journal contains only the granted subtree', async() => {
  await withServer(async baseUrl => {
    const response = await fetch(`${ baseUrl }/v1/collections/collection-a/journal?after=0`, { headers: { authorization: `Bearer ${ memberToken }` } });
    assert.equal(response.status, 200);
    const rows:any[] = await response.json();
    assert.deepEqual(rows.map(row => row.file.path), ['Team/notes.md']);
  });
});

test('share relay requires local authentication and denies unknown links', async() => {
  await withServer(async baseUrl => {
    const unauthenticated = await fetch(`${ baseUrl }/v1/local/shares/not-shared/content`);
    assert.equal(unauthenticated.status, 401);
    const unknown = await fetch(`${ baseUrl }/v1/local/shares/not-shared/content`, { headers: { 'x-sulla-files-token': 'local-test-token' } });
    assert.equal(unknown.status, 404);
  });
});
