// SPDX-License-Identifier: GPL-2.0-or-later
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
        query(sql, params = []) {
            if (sql.startsWith("SELECT id FROM collections WHERE kind='knowledge'"))
                return { rows: [{ id: 'collection-a' }], rowCount: 1 };
            if (sql.startsWith('SELECT * FROM collections WHERE id=$1'))
                return { rows: [{ id: 'collection-a', org_id: 'org-a', owner_user_id: 'owner-1', kind: 'knowledge' }], rowCount: 1 };
            if (sql.startsWith('SELECT role FROM collection_acl')) {
                const role = params[1] === 'agent-user-1' ? 'use-by-agents' : params[1] === 'viewer-1' || params[1] === 'agent-viewer-1' ? 'view' : undefined;
                return { rows: role ? [{ role }] : [], rowCount: role ? 1 : 0 };
            }
            if (sql.includes('SELECT folder_path,role FROM folder_shares'))
                return { rows: params[1] === 'member-1' ? [{ folder_path: 'Team', role: 'view' }] : [], rowCount: params[1] === 'member-1' ? 1 : 0 };
            if (sql === 'SELECT * FROM files WHERE id=$1')
                return { rows: [{ id: params[0], collection_id: 'collection-a', path: 'Private/plan.md', current_version_id: 'version-private' }], rowCount: 1 };
            if (sql.includes('FROM journal j')) {
                assert.deepEqual(params[2], ['Team'], 'sync feed must be constrained to the shared folder');
                return { rows: [{ seq: 9, file: { id: 'team-file', collection_id: 'collection-a', path: 'Team/notes.md' }, version: { id: 'team-version', device_id: 'owner-device' }, manifest: { hash: 'manifest', chunk_ids: [] } }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        },
    };
}
function fakeIdentityDb() {
    return {
        async query(sql, params = []) {
            if (sql.includes('FROM users WHERE id=$1'))
                return { rows: [{ '?column?': 1 }], rowCount: 1 };
            if (sql.includes('FROM org_members om JOIN users')) {
                const confirmed = params[0] !== 'outsider-1';
                return { rows: confirmed ? [{ '?column?': 1 }] : [], rowCount: confirmed ? 1 : 0 };
            }
            if (sql.includes('FROM group_members gm JOIN org_groups'))
                return { rows: [], rowCount: 0 };
            return { rows: [], rowCount: 0 };
        },
    };
}
async function withServer(fn, options = {}) {
    const server = createApp(options.db ?? fakeDb(), { keyring: { unlocked: true }, chunkRoot: '/tmp/sulla-files-sharing-test', dataRoot: '/tmp/sulla-files-sharing-test', modelDir: '/tmp/sulla-files-sharing-test', databaseUrl: '', port: 0, capabilitySigningKey: signingKey, localToken: 'local-test-token', mode: 'server', deviceId: 'test', userId: 'owner-1', cloudUrl: 'https://cloud.invalid', caseInsensitiveRoot: false, paused: false }, undefined, options.identityDb ?? fakeIdentityDb(), options.search).listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    try {
        await fn(`http://127.0.0.1:${server.address().port}`);
    }
    finally {
        server.close();
    }
}
test('trashed file metadata stays accessible with per-file capabilities without resolving tombstone content', async () => {
    const trashed = {
        id: 'trashed-file', collection_id: 'collection-a', path: 'Records/expired.txt', mime: 'text/plain', size: 17,
        current_version_id: 'delete-tombstone', draft_version_id: 'private-draft', published_version_id: 'published-version',
        created_by_type: 'user', created_by_id: 'owner-1', deleted_at: new Date('2026-10-18T20:00:00.000Z'),
        retention_mode: 'none', record_lock_type: 'none', disposal_status: 'pending',
    };
    const contentQueries = [];
    const query = (sql, params = []) => {
        if (sql.startsWith('SELECT collection_id,chunk_id,audit_id FROM file_chunk_gc'))
            return { rows: [], rowCount: 0 };
        if (sql.startsWith('SELECT * FROM collections WHERE id=$1'))
            return { rows: [{ id: 'collection-a', org_id: 'org-a', owner_user_id: 'owner-1', kind: 'knowledge' }], rowCount: 1 };
        if (sql.startsWith('SELECT role FROM collection_acl'))
            return { rows: params[1] === 'viewer-1' ? [{ role: 'view' }] : [], rowCount: params[1] === 'viewer-1' ? 1 : 0 };
        if (sql.includes('SELECT folder_path,role FROM folder_shares') || sql.includes('SELECT s.file_id::text, s.role FROM file_shares'))
            return { rows: [], rowCount: 0 };
        if (sql === 'SELECT * FROM files WHERE id=$1')
            return { rows: [trashed], rowCount: 1 };
        if (sql.startsWith('SELECT * FROM files WHERE NOT EXISTS'))
            return { rows: [trashed], rowCount: 1 };
        if (sql === 'SELECT 1 FROM files_protected_files WHERE file_id=$1')
            return { rows: [], rowCount: 0 };
        if (sql.includes('FROM file_versions') || sql.includes('FROM recording_metadata')) {
            contentQueries.push(sql);
            throw new Error('trashed metadata must not resolve file content');
        }
        return { rows: [], rowCount: 0 };
    };
    const db = { query };
    await withServer(async (baseUrl) => {
        const get = (path, token) => fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
        const ownerTrash = await (await get('/v1/trash?collectionId=collection-a', ownerToken)).json();
        assert.deepEqual(ownerTrash[0].capabilities, { canEdit: true, canManage: true, canViewDraft: true, canPublish: true });
        const ownerDetail = await (await get('/v1/files/trashed-file', ownerToken)).json();
        assert.deepEqual(ownerDetail.capabilities, ownerTrash[0].capabilities);
        assert.equal(ownerDetail.disposal.status, 'pending');
        assert.equal(ownerDetail.version, null);
        assert.deepEqual(contentQueries, []);
    }, { db });
});
test('maintenance soft-deletes expired files without deleting retained version chunks', async () => {
    const sqlLog = [];
    const retainedVersions = ['expired-original', 'deleted-original', 'promoted-original'];
    const retainedChunks = ['expired-chunk', 'deleted-chunk', 'promoted-source-chunk'];
    const query = (sql) => {
        sqlLog.push(sql);
        if (sql.startsWith('SELECT * FROM files WHERE expires_at'))
            return { rows: [{ id: 'expired-file', collection_id: 'scratch-a', current_version_id: 'expired-original' }], rowCount: 1 };
        if (sql.includes('INSERT INTO file_versions'))
            return { rows: [{ id: 'expired-tombstone' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    };
    const db = { query, connect: () => Promise.resolve({ query, release() { } }) };
    await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/local/maintenance`, { method: 'POST', headers: { 'x-sulla-files-token': 'local-test-token' } });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { expiredFiles: 1 });
    }, { db });
    assert.deepEqual(retainedVersions, ['expired-original', 'deleted-original', 'promoted-original']);
    assert.deepEqual(retainedChunks, ['expired-chunk', 'deleted-chunk', 'promoted-source-chunk']);
    assert.equal(sqlLog.some(sql => /(?:UPDATE|DELETE FROM) chunks/i.test(sql)), false, 'maintenance must not mutate chunk retention');
});
