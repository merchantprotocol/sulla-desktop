import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isLegacyInternalPath, runLegacyPreflight } from './legacyPreflight.js';

const collectionId = '12345678-1234-4123-8123-123456789abc';
const chunkId = 'a'.repeat(64);

function database(externalIds:string[] = []) {
  let preflight:any; const protectedPaths:string[] = [];
  return {
    protectedPaths,
    async query(sql:string, values:any[] = []) {
      if (sql.startsWith('SELECT state,protected_prefix')) return { rows: preflight ? [preflight] : [] };
      if (sql.startsWith("SELECT id::text FROM collections")) return { rows: externalIds.map(id => ({ id })) };
      if (sql.startsWith('INSERT INTO files_legacy_preflight')) {
        preflight = preflight?.state === 'secure-import-required' ? preflight : { state: values[0], protected_prefix: values[1] };
      }
      if (sql.startsWith('INSERT INTO files_protected_files')) protectedPaths.push(values[0]);
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

test('case-insensitive legacy layout is contained before unlock and repeat startup is non-destructive', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-preflight-'));
  const key = Buffer.alloc(32, 7); const chunk = Buffer.from('synthetic ciphertext');
  try {
    await mkdir(join(root, 'Chunks', collectionId, 'aa'), { recursive: true });
    await writeFile(join(root, 'MASTER.KEY'), key);
    await writeFile(join(root, 'Chunks', collectionId, 'aa', chunkId), chunk);
    const before = await stat(join(root, 'MASTER.KEY')); const db = database([collectionId]);
    const first = await runLegacyPreflight(db, root, { caseInsensitive: true });
    const second = await runLegacyPreflight(db, root, { caseInsensitive: true });
    assert.equal(first.state, 'secure-import-required'); assert.equal(second.state, 'secure-import-required');
    assert.equal(first.protectedPrefix, 'Chunks'); assert.equal(isLegacyInternalPath('chunks/anything', first), true);
    assert.deepEqual(await readFile(join(root, 'MASTER.KEY')), key); assert.deepEqual(await readFile(join(root, 'Chunks', collectionId, 'aa', chunkId)), chunk);
    assert.equal((await stat(join(root, 'MASTER.KEY'))).ino, before.ino);
  } finally { await rm(root, { recursive: true }) }
});

test('an ordinary user folder named chunks is not broadly hidden', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-preflight-user-'));
  try {
    await mkdir(join(root, 'chunks')); await writeFile(join(root, 'chunks', 'notes.txt'), 'ordinary user content');
    const status = await runLegacyPreflight(database(), root, { caseInsensitive: true });
    assert.deepEqual(status, { state: 'clear' }); assert.equal(isLegacyInternalPath('chunks/notes.txt', status), false);
  } finally { await rm(root, { recursive: true }) }
});
