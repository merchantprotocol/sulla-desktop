import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { desktopIndexSource } from './indexSource.js';

test('desktop index sources resolve the active mount for the file collection', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-index-root-'));
  await writeFile(join(root, 'same-name.txt'), 'root-specific content');
  const queries:{ sql:string; values:unknown[] }[] = [];
  const db = {
    query(sql:string, values:unknown[]) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT 1 FROM files_protected_files')) return Promise.resolve({ rowCount: 0, rows: [] });
      if (sql.startsWith('SELECT mount_path FROM file_roots')) return Promise.resolve({ rowCount: 1, rows: [{ mount_path: root }] });
      throw new Error(`Unexpected query: ${ sql }`);
    },
  };

  try {
    const source = await desktopIndexSource('/mnt/files/default', db as any)({
      id: 'file-1', collection_id: 'photos-collection', path: 'same-name.txt',
    });
    try {
      assert.notEqual(source.path, join(root, 'same-name.txt'));
      assert.equal(await readFile(source.path, 'utf8'), 'root-specific content');
      assert.deepEqual(queries.at(-1)?.values, ['photos-collection']);
    } finally { await source.cleanup?.() }
  } finally { await rm(root, { recursive: true, force: true }) }
});

test('desktop index sources do not follow symlinks outside the active mount', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-index-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'sulla-files-index-outside-'));
  await writeFile(join(outside, 'private.txt'), 'private');
  await symlink(outside, join(root, 'linked'));
  const db = {
    query(sql:string) {
      if (sql.startsWith('SELECT 1 FROM files_protected_files')) return Promise.resolve({ rowCount: 0, rows: [] });
      return Promise.resolve({ rowCount: 1, rows: [{ mount_path: root }] });
    },
  };
  try {
    await assert.rejects(
      desktopIndexSource(root, db as any)({ id: 'file-symlink', collection_id: 'default', path: 'linked/private.txt' }),
      /stable directory under root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
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
