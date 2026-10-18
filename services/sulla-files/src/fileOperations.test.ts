import assert from 'node:assert/strict';
import test from 'node:test';

import { applyDatabaseFileOperations, FileOperationConflict } from './fileOperations.js';

const source = { id: '11111111-1111-4111-8111-111111111111', collection_id: '22222222-2222-4222-8222-222222222222', path: 'old/report.txt', mime: 'text/plain', size: 12, current_version_id: '33333333-3333-4333-8333-333333333333' };
const actor = { userId: 'owner', deviceId: 'device', kind: 'capability' as const };

function fakeDb(collision = false, changed = false) {
  const statements:string[] = [];
  const query = (sql:string) => {
    statements.push(sql);
    if (sql.includes('FROM files WHERE id=') && sql.includes('FOR UPDATE')) return Promise.resolve({ rows: [{ ...source, path: changed ? 'moved/report.txt' : source.path }], rowCount: 1 });
    if (sql.startsWith('SELECT path FROM files')) return Promise.resolve({ rows: collision ? [{ path: 'new/report.txt' }] : [], rowCount: collision ? 1 : 0 });
    if (sql.includes('FROM file_versions v JOIN manifests')) return Promise.resolve({ rows: [{ chunk_collection_id: source.collection_id, manifest_hash: 'manifest', size: 12, chunk_ids: ['chunk-a'] }], rowCount: 1 });
    if (sql.startsWith('INSERT INTO files(')) return Promise.resolve({ rows: [{ ...source, id: '44444444-4444-4444-8444-444444444444', path: 'new/report.txt' }], rowCount: 1 });
    if (sql.startsWith('INSERT INTO file_versions')) return Promise.resolve({ rows: [{ id: '55555555-5555-4555-8555-555555555555' }], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 1 });
  };
  return { statements, pool: { connect: () => Promise.resolve({ query, release() {} }) } as any };
}

test('copy is transactional, refuses collisions, and retains encrypted chunk/index references', async() => {
  const success = fakeDb();
  const copied = await applyDatabaseFileOperations(success.pool, 'copy', [{ file: source, targetPath: 'new/report.txt' }], actor);
  assert.equal(copied[0].id, '44444444-4444-4444-8444-444444444444');
  assert.ok(success.statements.some(sql => sql.startsWith('UPDATE chunks SET refcount=refcount+1')));
  assert.ok(success.statements.some(sql => sql.startsWith('INSERT INTO file_index_jobs')));
  assert.ok(success.statements.some(sql => sql.startsWith('INSERT INTO audit_log')));
  assert.equal(success.statements.at(-1), 'COMMIT');

  const blocked = fakeDb(true);
  await assert.rejects(() => applyDatabaseFileOperations(blocked.pool, 'copy', [{ file: source, targetPath: 'new/report.txt' }], actor), FileOperationConflict);
  assert.equal(blocked.statements.at(-1), 'ROLLBACK');
  assert.equal(blocked.statements.some(sql => sql.startsWith('INSERT INTO files(')), false);

  const raced = fakeDb(false, true);
  await assert.rejects(() => applyDatabaseFileOperations(raced.pool, 'move', [{ file: source, targetPath: 'new/report.txt' }], actor), FileOperationConflict);
  assert.equal(raced.statements.at(-1), 'ROLLBACK');
});
