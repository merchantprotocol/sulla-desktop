import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FilesBootstrapAuthority } from './bootstrapAuthority.js';
import { FILES_BOOTSTRAP_DESTINATION, filesChallengeProofInput } from './bootstrapProtocol.js';
import { decryptChunk, encryptChunk, type Envelope } from './crypto.js';
import { FilesKeyring } from './keyring.js';
import { assertSeparateStorageRoots } from './localManager.js';

const signing = 'synthetic-signing-key-for-tests-only-32-bytes';
function database(ids:string[] = ['legacy']) {
  let verifier:Envelope | undefined;
  const rows = new Map<string, { collection_id: string; data_key: Envelope; dedup_key: Envelope; key_origin: string }>();
  let snapshot:any; let hook:((sql:string)=>Promise<void>) | undefined;
  const db:any = {
    setHook(value:typeof hook) { hook = value },
    async connect() { return { query: db.query, release() {} } },
    async query(sql:string, values:any[] = []) {
      await hook?.(sql);
      if (sql === 'BEGIN') snapshot = { verifier, rows: new Map(rows) };
      else if (sql === 'ROLLBACK') { verifier = snapshot.verifier; rows.clear(); for (const [id, row] of snapshot.rows) rows.set(id, row) }
      else if (sql.startsWith('SELECT verifier')) return { rows: verifier ? [{ verifier }] : [] };
      else if (sql.includes('FROM collections c LEFT JOIN files_collection_keys')) return { rows: ids.map(id => ({ id, ...(rows.get(id) ?? { data_key: null, dedup_key: null, key_origin: null }) })) };
      else if (sql.startsWith('INSERT INTO files_key_state')) verifier = values[0];
      else if (sql.startsWith('INSERT INTO files_collection_keys')) rows.set(values[0], { collection_id: values[0], data_key: values[1], dedup_key: values[2], key_origin: sql.includes('legacy-signing-v1') ? 'legacy-signing-v1' : 'random' });
      else if (sql.startsWith('SELECT collection_id,data_key')) return { rows: [...rows.values()] };
      else if (sql.startsWith('SELECT collection_id,key_origin')) return { rows: [...rows.values()].sort((a, b) => a.collection_id.localeCompare(b.collection_id)) };
      else if (sql.startsWith('SELECT data_key,dedup_key')) return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [] };
      else if (sql.startsWith('UPDATE files_collection_keys SET')) { const row = rows.get(values[0]); if (row) { row.data_key = values[1]; row.dedup_key = values[2] } }
      else if (!['BEGIN', 'ROLLBACK', 'COMMIT', 'LOCK TABLE files_key_state IN EXCLUSIVE MODE', 'LOCK TABLE files_key_state, files_collection_keys IN EXCLUSIVE MODE'].includes(sql)) throw new Error(`Unexpected test query ${ sql }`);
      return { rows: [], rowCount: 0 };
    },
    rows,
  };
  return db;
}

test('legacy content survives migration, restart uses wrapped keys, wrong master and corruption fail closed', async() => {
  const db = database(); const key = randomBytes(32); const ring = new FilesKeyring(db);
  const legacy = createHmac('sha256', signing).update('sulla:files:data-key:v1:legacy').digest();
  const chunk = await encryptChunk(Buffer.from('synthetic preserved content'), legacy, 'chunk');
  await ring.unlock(key, signing);
  assert.equal((await decryptChunk(chunk, (await ring.keys('legacy')).data, 'chunk')).toString(), 'synthetic preserved content');
  const cached = await ring.keys('legacy'); ring.close(); assert.ok(cached.data.every(byte => byte === 0));
  await assert.rejects(ring.unlock(randomBytes(32), signing)); assert.equal(ring.unlocked, false);
  await ring.unlock(key, 'changed-signing-key'); assert.deepEqual(Buffer.from((await ring.keys('legacy')).data), legacy);
  ring.close(); db.rows.get('legacy').data_key.ciphertext = 'damaged'; await assert.rejects(ring.unlock(key, signing));
});

test('new collection keys are random and authorized recovery preserves them', async() => {
  const db = database([]); const oldMaster = randomBytes(32); const replacementMaster = randomBytes(32); const ring = new FilesKeyring(db);
  await ring.unlock(oldMaster, signing); await ring.create('new', await db.connect()); const original = await ring.copyKeys('new');
  assert.notDeepEqual(Buffer.from(original.data), createHmac('sha256', signing).update('sulla:files:data-key:v1:new').digest()); ring.close();
  try {
    await ring.installRecoveredMaster(replacementMaster, new Map([['new', original]]));
    assert.deepEqual(Buffer.from((await ring.keys('new')).data), Buffer.from(original.data));
    ring.close(); await assert.rejects(ring.unlock(oldMaster, signing)); await ring.unlock(replacementMaster, signing);
    assert.deepEqual(Buffer.from((await ring.keys('new')).dedup), Buffer.from(original.dedup));
  } finally { original.data.fill(0); original.dedup.fill(0); ring.close() }
});

test('unknown external collections never receive replacement keys', async() => {
  const db = database(['native']); const ring = new FilesKeyring(db); await ring.unlock(randomBytes(32), signing);
  assert.deepEqual([...db.rows.keys()], ['native']); await assert.rejects(ring.keys('external-random-key'), /secure key exchange is required/); ring.close();
});

function gate() { let release!:()=>void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
test('lock racing unlock or key reads cannot repopulate key memory', async() => {
  const db = database(); const ring = new FilesKeyring(db); const key = randomBytes(32); const entered = gate(); const wait = gate();
  db.setHook(async(sql:string) => { if (sql.startsWith('SELECT verifier')) { entered.release(); await wait.promise } });
  const pending = ring.unlock(key, signing); await entered.promise; ring.close(); wait.release(); await assert.rejects(pending);
  db.setHook(undefined); await ring.unlock(key, signing); const readEntered = gate(); const readWait = gate();
  db.setHook(async(sql:string) => { if (sql.startsWith('SELECT data_key')) { readEntered.release(); await readWait.promise } });
  const read = ring.keys('legacy'); await readEntered.promise; ring.close(); readWait.release(); await assert.rejects(read);
  assert.equal(ring.unlocked, false); await assert.rejects(ring.keys('legacy'));
});

test('bootstrap consumes an identified challenge before rejecting malformed material', async() => {
  const identity = 'synthetic-bootstrap-identity-that-is-long-enough'; const callerId = 'synthetic-desktop';
  const lifecycle:any = { generation: 0, disposition: async() => 'existing', bootstrap: async() => ({ state: 'unlocked', legacyImport: 'clear', recovered: false }) };
  const authority = new FilesBootstrapAuthority(callerId, identity, lifecycle); const clientNonce = randomBytes(32).toString('base64url');
  const challenge = await authority.challenge({
    callerId, destination: FILES_BOOTSTRAP_DESTINATION, clientNonce, hasMasterBlob: true,
    clientProof: createHmac('sha256', identity).update(filesChallengeProofInput(callerId, clientNonce, true)).digest('base64url'),
  });
  const request = { callerId, destination: FILES_BOOTSTRAP_DESTINATION, challengeId: challenge.challengeId, sealedUnlock: 'not*base64url', clientProof: 'A'.repeat(43) } as const;
  await assert.rejects(authority.unlock(request), (error:any) => error?.code === 'FILES_BOOTSTRAP_REQUEST_INVALID');
  await assert.rejects(authority.unlock({ ...request, sealedUnlock: 'A'.repeat(32) }), (error:any) => error?.code === 'FILES_BOOTSTRAP_CHALLENGE_INVALID');
});

test('watched folder cannot overlap private storage through paths or symlinks', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-storage-boundary-')); const files = join(root, 'Files'); const data = join(root, 'private'); const chunks = join(data, 'chunks');
  try {
    await mkdir(files); await mkdir(chunks, { recursive: true }); await assertSeparateStorageRoots(files, data, chunks);
    await assert.rejects(assertSeparateStorageRoots(root, data, chunks), /must not overlap/);
    await assert.rejects(assertSeparateStorageRoots(chunks, data, chunks), /must not overlap/);
    await symlink(data, join(root, 'alias')); await assert.rejects(assertSeparateStorageRoots(join(root, 'alias'), data, chunks), /must not overlap/);
  } finally { await rm(root, { recursive: true }) }
});
