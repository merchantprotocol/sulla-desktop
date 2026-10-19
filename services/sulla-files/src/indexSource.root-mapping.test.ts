import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopIndexSource } from './indexSource.js';

test('desktop index sources resolve the active mount for the file collection', async() => {
  const queries:{ sql:string; values:unknown[] }[] = [];
  const db = {
    query(sql:string, values:unknown[]) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT 1 FROM files_protected_files')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.startsWith('SELECT mount_path FROM file_roots')) return Promise.resolve({ rowCount: 1, rows: [{ mount_path: '/mnt/files/photos' }] });
      throw new Error(`Unexpected query: ${ sql }`);
    },
  };

  const source = await desktopIndexSource('/mnt/files/default', db as any)({
    id: 'file-1', collection_id: 'photos-collection', path: 'same-name.txt',
  });

  assert.equal(source.path, '/mnt/files/photos/same-name.txt');
  assert.deepEqual(queries.at(-1)?.values, ['photos-collection']);
});

test('desktop index sources fail closed when a collection is detached', async() => {
  const db = {
    query(sql:string) {
      return Promise.resolve(sql.startsWith('SELECT 1 FROM files_protected_files') ? { rowCount: 0, rows: [] } : { rowCount: 0, rows: [] });
    },
  };

  await assert.rejects(
    desktopIndexSource('/mnt/files/default', db as any)({ id: 'file-2', collection_id: 'detached', path: 'file.txt' }),
    /no active Files root/,
  );
});

test('desktop index sources reject wallet paths before resolving a mount', async() => {
  const db = { query: () => Promise.reject(new Error('database must not be consulted')) };

  await assert.rejects(
    desktopIndexSource('/mnt/files/default', db as any)({ id: 'file-3', collection_id: 'default', path: 'crypto-wallet/seed.txt' }),
    /Protected system file/,
  );
});
