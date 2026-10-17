import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from './app.js';
import { isLegacyInternalPath, runLegacyPreflight } from './legacyPreflight.js';

const collectionId = '12345678-1234-4123-8123-123456789abc';
const chunkId = 'a'.repeat(64);

function database(externalIds:string[] = [], ambiguousIds:string[] = []) {
  let preflight:any; const protectedPaths:string[] = []; const classifiedIds = [...externalIds]; const queries:string[] = [];
  return {
    protectedPaths,
    queries,
    query(sql:string, values:any[] = []) {
      queries.push(sql);
      if (sql.startsWith('UPDATE collections c SET compatibility_state')) classifiedIds.push(...ambiguousIds.filter(id => !classifiedIds.includes(id)));
      if (sql.startsWith('SELECT state,protected_prefix')) return { rows: preflight ? [preflight] : [] };
      if (sql.startsWith('SELECT id::text FROM collections')) return { rows: classifiedIds.map(id => ({ id })) };
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

test('master marker recognizes an external legacy shape without a matching database row', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-preflight-marker-'));
  try {
    await mkdir(join(root, 'chunks', collectionId, 'aa'), { recursive: true });
    await writeFile(join(root, 'master.key'), Buffer.alloc(32, 3));
    await writeFile(join(root, 'chunks', collectionId, 'aa', chunkId), 'synthetic ciphertext');
    const status = await runLegacyPreflight(database(), root);
    assert.equal(status.state, 'secure-import-required');
    assert.equal(status.protectedPrefix, 'chunks');
  } finally { await rm(root, { recursive: true }) }
});

test('exact root legacy shape stays contained after its master was archived or quarantined', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-preflight-archived-'));
  try {
    await mkdir(join(root, 'chunks', collectionId, 'aa'), { recursive: true });
    await writeFile(join(root, 'chunks', collectionId, 'aa', chunkId), 'synthetic ciphertext');
    const status = await runLegacyPreflight(database(), root);
    assert.equal(status.state, 'secure-import-required');
    assert.equal(isLegacyInternalPath('chunks/notes.txt', status), true);
  } finally { await rm(root, { recursive: true }) }
});

test('all external collection ids are considered without a truncation window', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-preflight-many-'));
  const ids = Array.from({ length: 257 }, (_, index) => `00000000-0000-4000-8000-${ String(index).padStart(12, '0') }`);
  try {
    const last = ids.at(-1)!;
    await mkdir(join(root, 'chunks', last, 'aa'), { recursive: true });
    await writeFile(join(root, 'chunks', last, 'aa', chunkId), 'synthetic ciphertext');
    const status = await runLegacyPreflight(database(ids), root);
    assert.equal(status.state, 'secure-import-required');
  } finally { await rm(root, { recursive: true }) }
});

test('late ambiguous collection metadata is classified before legacy shape detection', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-preflight-classify-'));
  try {
    await mkdir(join(root, 'chunks', collectionId, 'aa'), { recursive: true });
    await writeFile(join(root, 'chunks', collectionId, 'aa', chunkId), 'synthetic ciphertext');
    const db = database([], [collectionId]);
    const status = await runLegacyPreflight(db, root);
    assert.equal(status.state, 'secure-import-required');
    assert.ok(db.queries.findIndex(sql => sql.startsWith('UPDATE collections')) < db.queries.findIndex(sql => sql.startsWith('SELECT id::text')));
  } finally { await rm(root, { recursive: true }) }
});

test('invalid or inaccessible watched-root metadata fails closed', async() => {
  const directory = await mkdtemp(join(tmpdir(), 'sulla-files-preflight-invalid-'));
  const root = join(directory, 'not-a-directory');
  try {
    await writeFile(root, 'synthetic');
    await assert.rejects(runLegacyPreflight(database(), root), /could not inspect the watched-root metadata/);
  } finally { await rm(directory, { recursive: true }) }
});

test('every unlock reruns classification and cannot manufacture native keys for external content', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-preflight-unlock-'));
  let unlocks = 0;
  try {
    await mkdir(join(root, 'chunks', collectionId, 'aa'), { recursive: true });
    await writeFile(join(root, 'master.key'), Buffer.alloc(32, 5));
    await writeFile(join(root, 'chunks', collectionId, 'aa', chunkId), 'synthetic ciphertext');
    const db = database();
    const config:any = {
      keyring:              { unlocked: false, unlock() { unlocks++; return Promise.resolve() }, close() {} },
      legacyPreflight:      { state: 'clear' },
      filesRoot:            root,
      caseInsensitiveRoot:  false,
      chunkRoot:            join(root, 'private-chunks'),
      capabilitySigningKey: 'synthetic-signing-key-for-tests-only-32-bytes',
      localToken:           'synthetic-local-token',
      mode:                 'desktop',
    };
    const server = createApp(db, config).listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${ (server.address() as any).port }`;
      const response = await fetch(`${ base }/v1/local/unlock`, {
        method:  'POST',
        headers: { 'content-type': 'application/json', 'x-sulla-files-token': config.localToken },
        body:    JSON.stringify({ masterKey: randomBytes(32).toString('base64') }),
      });
      assert.equal(response.status, 503);
      assert.equal(unlocks, 0);
      assert.equal(config.legacyPreflight.state, 'secure-import-required');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  } finally { await rm(root, { recursive: true }) }
});
