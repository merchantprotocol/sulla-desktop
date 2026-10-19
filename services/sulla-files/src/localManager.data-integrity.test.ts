import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalFilesManager } from './localManager.js';

function managerWithQueries(queries:string[]) {
  const db = {
    query: (sql:string) => {
      queries.push(sql);
      return Promise.resolve(sql.startsWith('UPDATE file_roots')
        ? { rowCount: 1, rows: [{ collection_id: '22222222-2222-4222-8222-222222222222' }] }
        : { rowCount: 0, rows: [] });
    },
  };

  return new LocalFilesManager(db as any, {
    databaseUrl:          '',
    chunkRoot:            '/tmp/sulla-files-root-test/chunks',
    dataRoot:             '/tmp/sulla-files-root-test/data',
    filesRoot:            '/tmp/sulla-files-root-test/default',
    caseInsensitiveRoot:  false,
    capabilitySigningKey: 'sulla-files-root-test-key-32bytes',
    mode:                 'desktop',
    deviceId:             'test-device',
    userId:               'test-user',
    cloudUrl:             'https://cloud.invalid',
    paused:               false,
    modelDir:             '/tmp/sulla-files-root-test/models',
    fileRoots:            [
      { id: 'default', name: 'Sulla Files', path: '/tmp/sulla-files-root-test/default', syncMode: 'local', paused: false, exclusions: [], primary: true },
      { id: 'photos', name: 'Photos', path: '/tmp/sulla-files-root-test/photos', syncMode: 'local', paused: false, exclusions: [], primary: false },
    ],
  });
}

test('detaching a root drops watcher custody without deleting source or creating tombstones', async() => {
  const queries:string[] = [];
  const manager = managerWithQueries(queries);

  await manager.detachRoot('photos');

  assert.equal(queries.length, 2);
  assert.match(queries[0], /^UPDATE file_roots SET enabled=FALSE/);
  assert.equal(queries[1], 'DELETE FROM watched_folder_state WHERE root_id=$1');
  assert.equal(queries.some(sql => /(?:DELETE FROM files|INSERT INTO file_versions|INSERT INTO journal)/.test(sql)), false);
});

test('the migrated default root cannot be detached', async() => {
  const queries:string[] = [];
  const manager = managerWithQueries(queries);

  await assert.rejects(manager.detachRoot('default'), /cannot be removed/);
  assert.deepEqual(queries, []);
});
