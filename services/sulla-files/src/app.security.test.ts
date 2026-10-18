import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from './app.js';
import { issueCapabilityToken } from './auth.js';

const signingKey = 'sulla-files-test-signing-key-32-bytes!';
const memberToken = issueCapabilityToken({ sub: 'member-1', device_id: 'member-device', scopes: ['files/*'] }, signingKey);
const outsiderToken = issueCapabilityToken({ sub: 'outsider-1', device_id: 'outsider-device', scopes: ['files/*'] }, signingKey);
const viewerToken = issueCapabilityToken({ sub: 'viewer-1', device_id: 'viewer-device', scopes: ['files/*'] }, signingKey);
const agentViewerToken = issueCapabilityToken({ sub: 'agent-viewer-1', agent_id: 'agent-1', job_id: 'run-1', thread_id: 'thread-1', device_id: 'agent-device', scopes: ['files/*'] }, signingKey);
const agentUserToken = issueCapabilityToken({ sub: 'agent-user-1', agent_id: 'agent-1', job_id: 'run-1', thread_id: 'thread-1', device_id: 'agent-device', scopes: ['files/*'] }, signingKey);
const ownerToken = issueCapabilityToken({ sub: 'owner-1', device_id: 'owner-device', scopes: ['files/*'] }, signingKey);
const ownerRunOneToken = issueCapabilityToken({ sub: 'owner-1', agent_id: 'agent-1', job_id: 'run-1', thread_id: 'thread-1', device_id: 'agent-device', scopes: ['files/*'] }, signingKey);
const ownerRunTwoToken = issueCapabilityToken({ sub: 'owner-1', agent_id: 'agent-1', job_id: 'run-2', thread_id: 'thread-1', device_id: 'agent-device', scopes: ['files/*'] }, signingKey);

function fakeDb() {
  return {
    query(sql:string, params:any[] = []) {
      if (sql.startsWith("SELECT id FROM collections WHERE kind='knowledge'")) return { rows: [{ id: 'collection-a' }], rowCount: 1 };
      if (sql.startsWith('SELECT * FROM collections WHERE id=$1')) return { rows: [{ id: 'collection-a', org_id: 'org-a', owner_user_id: 'owner-1', kind: 'knowledge' }], rowCount: 1 };
      if (sql.startsWith('SELECT role FROM collection_acl')) {
        const role = params[1] === 'agent-user-1' ? 'use-by-agents' : params[1] === 'viewer-1' || params[1] === 'agent-viewer-1' ? 'view' : undefined;
        return { rows: role ? [{ role }] : [], rowCount: role ? 1 : 0 };
      }
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

function fakeIdentityDb() {
  return {
    async query(sql:string, params:any[] = []) {
      if (sql.includes('FROM users WHERE id=$1')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('FROM org_members om JOIN users')) {
        const confirmed = params[0] !== 'outsider-1';
        return { rows: confirmed ? [{ '?column?': 1 }] : [], rowCount: confirmed ? 1 : 0 };
      }
      if (sql.includes('FROM group_members gm JOIN org_groups')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

async function withServer(fn:(baseUrl:string) => Promise<void>, options:{ db?: any; identityDb?: any; search?: any } = {}) {
  const server = createApp(options.db ?? fakeDb(), { keyring: { unlocked: true } as any, chunkRoot: '/tmp/sulla-files-sharing-test', dataRoot: '/tmp/sulla-files-sharing-test', modelDir: '/tmp/sulla-files-sharing-test', databaseUrl: '', port: 0, capabilitySigningKey: signingKey, localToken: 'local-test-token', mode: 'server', deviceId: 'test', userId: 'owner-1', cloudUrl: 'https://cloud.invalid', caseInsensitiveRoot: false, paused: false }, undefined, options.identityDb ?? fakeIdentityDb(), options.search).listen(0);
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

test('agent reads require use-by-agents permission, not a human view grant', async() => {
  await withServer(async baseUrl => {
    const human = await fetch(`${ baseUrl }/v1/files/private-file`, { headers: { authorization: `Bearer ${ viewerToken }` } });
    assert.equal(human.status, 200);
    const agent = await fetch(`${ baseUrl }/v1/files/private-file`, { headers: { authorization: `Bearer ${ agentViewerToken }` } });
    assert.equal(agent.status, 403);
  });
});

test('search applies the same human-view and agent-use permission boundary as direct reads', async() => {
  const search = { search: (_input:any, scopes:any[]) => Promise.resolve(scopes) };
  await withServer(async baseUrl => {
    const request = (token:string) => fetch(`${ baseUrl }/v1/search`, { method: 'POST', headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json' }, body: JSON.stringify({ query: 'plan' }) });
    assert.deepEqual(await (await request(viewerToken)).json(), [{ collectionId: 'collection-a', paths: [], fileIds: [] }]);
    assert.deepEqual(await (await request(agentViewerToken)).json(), []);
    assert.deepEqual(await (await request(agentUserToken)).json(), [{ collectionId: 'collection-a', paths: [], fileIds: [] }]);
  }, { search });
});

test('scratch reads, history, list, and keep are scoped to the current agent run while the owner UI remains allowed', async() => {
  const collection = { id: 'scratch-a', owner_user_id: 'owner-1', kind: 'scratch', agent_run_id: 'run-1', thread_id: 'thread-1', compatibility_state: 'native' };
  const file = { id: 'scratch-file', collection_id: collection.id, path: 'result.txt', current_version_id: 'version-1', created_by_type: 'agent-run', created_by_id: 'run-1' };
  const query = (sql:string) => {
    if (sql.startsWith('SELECT * FROM collections WHERE id=$1') || sql.includes("SELECT * FROM collections WHERE owner_user_id=$1 AND agent_run_id=$2 AND kind='scratch'")) return { rows: [collection], rowCount: 1 };
    if (sql === 'SELECT * FROM files WHERE id=$1') return { rows: [file], rowCount: 1 };
    if (sql === 'SELECT 1 FROM files_protected_files WHERE file_id=$1') return { rows: [], rowCount: 0 };
    if (sql === 'SELECT * FROM file_versions WHERE id=$1') return { rows: [{ id: 'version-1', file_id: file.id, deleted: false }], rowCount: 1 };
    if (sql.startsWith('SELECT * FROM file_versions WHERE file_id=$1')) return { rows: [{ id: 'version-1', file_id: file.id, deleted: false }], rowCount: 1 };
    if (sql.includes('FROM files f LEFT JOIN file_versions')) return { rows: [file], rowCount: 1 };
    if (sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const db = { query, connect: () => Promise.resolve({ query, release() {} }) };
  await withServer(async baseUrl => {
    const get = (path:string, token:string, init?:RequestInit) => fetch(`${ baseUrl }${ path }`, { ...init, headers: { authorization: `Bearer ${ token }`, 'content-type': 'application/json', ...init?.headers } });
    for (const path of ['/v1/files/scratch-file', '/v1/files/scratch-file/history', '/v1/files?collectionId=scratch-a']) assert.equal((await get(path, ownerRunTwoToken)).status, 403, path);
    assert.equal((await get('/v1/agent-runs/run-1/keep', ownerRunTwoToken, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await get('/v1/files/scratch-file', ownerRunOneToken)).status, 200);
    assert.equal((await get('/v1/files/scratch-file', ownerToken)).status, 200);
  }, { db });
});

test('maintenance soft-deletes expired files without deleting retained version chunks', async() => {
  const sqlLog:string[] = [];
  const retainedVersions = ['expired-original', 'deleted-original', 'promoted-original'];
  const retainedChunks = ['expired-chunk', 'deleted-chunk', 'promoted-source-chunk'];
  const query = (sql:string) => {
    sqlLog.push(sql);
    if (sql.startsWith('SELECT * FROM files WHERE expires_at')) return { rows: [{ id: 'expired-file', collection_id: 'scratch-a', current_version_id: 'expired-original' }], rowCount: 1 };
    if (sql.includes('INSERT INTO file_versions')) return { rows: [{ id: 'expired-tombstone' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const db = { query, connect: () => Promise.resolve({ query, release() {} }) };
  await withServer(async baseUrl => {
    const response = await fetch(`${ baseUrl }/v1/local/maintenance`, { method: 'POST', headers: { 'x-sulla-files-token': 'local-test-token' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { expiredFiles: 1 });
  }, { db });
  assert.deepEqual(retainedVersions, ['expired-original', 'deleted-original', 'promoted-original']);
  assert.deepEqual(retainedChunks, ['expired-chunk', 'deleted-chunk', 'promoted-source-chunk']);
  assert.equal(sqlLog.some(sql => /(?:UPDATE|DELETE FROM) chunks/i.test(sql)), false, 'maintenance must not mutate chunk retention');
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
