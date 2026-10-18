import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from './app.js';
import { issueCapabilityToken } from './auth.js';
import { decryptChunk, encryptChunk, type Envelope } from './crypto.js';
import { FilesKeyring } from './keyring.js';
import { assertSeparateStorageRoots } from './localManager.js';

const signing = 'synthetic-signing-key-for-tests-only-32-bytes';
function database(ids:string[] = ['legacy'], ambiguousIds:string[] = []) {
  let verifier:Envelope | undefined;
  const rows = new Map<string, { collection_id: string; data_key: Envelope; dedup_key: Envelope; key_origin: string }>();
  let snapshot:any;
  let hook:((sql:string)=>Promise<void>) | undefined;
  const db:any = {
    setHook(value:typeof hook) { hook = value },
    async connect() { await Promise.resolve(); return { query: db.query, release() {} } },
    async query(sql:string, values:any[] = []) {
      await hook?.(sql);
      if (sql === 'BEGIN') snapshot = { verifier, rows: new Map(rows) };
      else if (sql === 'ROLLBACK') { verifier = snapshot.verifier; rows.clear(); for (const [id, row] of snapshot.rows) rows.set(id, row); } else if (sql.startsWith('SELECT verifier')) return { rows: verifier ? [{ verifier }] : [] };
      else if (sql.startsWith('SELECT id FROM collections')) return { rows: ids.map(id => ({ id })) };
      else if (sql.startsWith('INSERT INTO files_key_state')) verifier = values[0];
      else if (sql.startsWith('INSERT INTO files_collection_keys')) rows.set(values[0], { collection_id: values[0], data_key: values[1], dedup_key: values[2], key_origin: sql.includes('legacy-signing-v1') ? 'legacy-signing-v1' : 'random' });
      else if (sql.startsWith('SELECT collection_id,data_key')) return { rows: [...rows.values()] };
      else if (sql.startsWith('SELECT collection_id,key_origin')) return { rows: [...rows.values()].sort((a, b) => a.collection_id.localeCompare(b.collection_id)) };
      else if (sql.startsWith('SELECT data_key,dedup_key')) return { rows: rows.has(values[0]) ? [rows.get(values[0])] : [] };
      else if (sql.startsWith('UPDATE files_collection_keys SET')) {
        const row = rows.get(values[0]); if (row) { row.data_key = values[1]; row.dedup_key = values[2] }
      } else if (!['BEGIN', 'ROLLBACK', 'COMMIT', 'LOCK TABLE files_key_state IN EXCLUSIVE MODE', 'LOCK TABLE files_key_state, files_collection_keys IN EXCLUSIVE MODE'].includes(sql)) throw new Error(`Unexpected test query ${ sql }`);
      return { rows: [], rowCount: 0 };
    },
    rows,
    ambiguousIds,
  };
  return db;
}

test('legacy content survives migration, restart uses wrapped keys, wrong master/corruption fail closed', async() => {
  const db = database(); const key = randomBytes(32); const ring = new FilesKeyring(db);
  const legacy = createHmac('sha256', signing).update('sulla:files:data-key:v1:legacy').digest();
  const chunk = await encryptChunk(Buffer.from('synthetic preserved content'), legacy, 'chunk');
  await ring.unlock(key, signing);
  assert.equal((await decryptChunk(chunk, (await ring.keys('legacy')).data, 'chunk')).toString(), 'synthetic preserved content');
  const cached = await ring.keys('legacy'); ring.close(); assert.ok(cached.data.every(byte => byte === 0));
  await assert.rejects(ring.unlock(randomBytes(32), signing)); assert.equal(ring.unlocked, false);
  await ring.unlock(key, 'changed-signing-key');
  assert.deepEqual(Buffer.from((await ring.keys('legacy')).data), legacy);
  await assert.rejects(ring.keys('missing'), /key unavailable/);
  ring.close(); db.rows.get('legacy').data_key.ciphertext = 'damaged';
  await assert.rejects(ring.unlock(key, signing)); assert.equal(ring.unlocked, false);
});

test('new collection keys are random, not signing-derived, and survive restart', async() => {
  const db = database([]); const key = randomBytes(32); const ring = new FilesKeyring(db);
  await ring.unlock(key, signing); await ring.create('new', await db.connect());
  const before = Buffer.from((await ring.keys('new')).data);
  assert.notDeepEqual(before, createHmac('sha256', signing).update('sulla:files:data-key:v1:new').digest());
  ring.close(); await ring.unlock(key, 'other'); assert.deepEqual(Buffer.from((await ring.keys('new')).data), before); ring.close();
});

test('ambiguous legacy collections never receive signing-derived replacement keys', async() => {
  const db = database(['native'], ['external-random']); const ring = new FilesKeyring(db);
  await ring.unlock(randomBytes(32), signing);
  assert.deepEqual([...db.rows.keys()], ['native']);
  await assert.rejects(ring.keys('external-random'), /secure key exchange is required/);
  ring.close();
});

test('authorized recovery replaces the local master without changing random collection keys', async() => {
  const db = database([]); const oldMaster = randomBytes(32); const replacementMaster = randomBytes(32);
  const ring = new FilesKeyring(db); await ring.unlock(oldMaster, signing); await ring.create('new', await db.connect());
  const original = await ring.copyKeys('new'); ring.close();
  try {
    await ring.installRecoveredMaster(replacementMaster, new Map([['new', original]]));
    assert.deepEqual(Buffer.from((await ring.keys('new')).data), Buffer.from(original.data));
    ring.close();
    await assert.rejects(ring.unlock(oldMaster, signing));
    await ring.unlock(replacementMaster, signing);
    assert.deepEqual(Buffer.from((await ring.keys('new')).dedup), Buffer.from(original.dedup));
  } finally {
    original.data.fill(0); original.dedup.fill(0); ring.close();
  }
});

function gate() { let release!:()=>void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
test('lock racing unlock or key reads cannot repopulate key memory', async() => {
  const db = database(); const ring = new FilesKeyring(db); const key = randomBytes(32); const entered = gate(); const wait = gate();
  db.setHook(async(sql:string) => { if (sql.startsWith('SELECT verifier')) { entered.release(); await wait.promise } });
  const pending = ring.unlock(key, signing); await entered.promise; ring.close(); wait.release();
  await assert.rejects(pending); assert.equal(ring.unlocked, false);
  db.setHook(undefined); await ring.unlock(key, signing);
  const readEntered = gate(); const readWait = gate();
  db.setHook(async(sql:string) => { if (sql.startsWith('SELECT data_key')) { readEntered.release(); await readWait.promise } });
  const read = ring.keys('legacy'); await readEntered.promise; ring.close(); readWait.release(); await assert.rejects(read);
  assert.equal(ring.unlocked, false); await assert.rejects(ring.keys('legacy'));
});

test('bootstrap requires local authentication; startup and explicit lock deny file access', async() => {
  const db = database([]); const keyring = new FilesKeyring(db);
  const config:any = { keyring, chunkRoot: '/tmp/sulla-synthetic-keyring', capabilitySigningKey: signing, localToken: 'synthetic-local-token', mode: 'desktop' };
  const server = createApp(db, config).listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${ (server.address() as any).port }`;
  const key = randomBytes(32).toString('base64'); const body = JSON.stringify({ masterKey: key });
  const token = issueCapabilityToken({ sub: 'synthetic', scopes: ['files/*'] }, signing);
  try {
    assert.equal((await (await fetch(`${ base }/healthz`)).json()).locked, true);
    assert.equal((await fetch(`${ base }/v1/collections`, { headers: { authorization: `Bearer ${ token }` } })).status, 503);
    assert.equal((await fetch(`${ base }/v1/local/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ token }` }, body })).status, 401);
    const headers = { 'content-type': 'application/json', 'x-sulla-files-token': config.localToken };
    assert.equal((await fetch(`${ base }/v1/local/unlock`, { method: 'POST', headers, body })).status, 200);
    assert.equal((await (await fetch(`${ base }/healthz`)).json()).locked, false);
    assert.equal((await fetch(`${ base }/v1/local/lock`, { method: 'POST', headers })).status, 200);
    assert.equal((await (await fetch(`${ base }/healthz`)).json()).locked, true);
    assert.equal(keyring.unlocked, false);
  } finally { keyring.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
});

test('locked recovery handler authenticates, persists the replacement master, and scrubs its request copy', async() => {
  const db = database([]); const keyring = new FilesKeyring(db);
  const oldMaster = randomBytes(32); const replacementMaster = randomBytes(32);
  await keyring.unlock(oldMaster, signing); await keyring.create('new', await db.connect());
  const original = await keyring.copyKeys('new'); keyring.close();
  const config:any = { keyring, chunkRoot: '/tmp/sulla-synthetic-keyring', capabilitySigningKey: signing, localToken: 'synthetic-local-token', mode: 'desktop' };
  let initialized = false; let recoveryRequest!:Buffer;
  const recover = async(master:Buffer) => {
    recoveryRequest = master;
    await keyring.installRecoveredMaster(master, new Map([['new', original]]));
    return 1;
  };
  const server = createApp(db, config, undefined, undefined, undefined, async() => {
    await Promise.resolve(); initialized = true; config.userId = 'vault-principal';
  }, undefined, recover).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${ (server.address() as any).port }`;
  const body = JSON.stringify({ masterKey: replacementMaster.toString('base64') });
  try {
    assert.equal((await fetch(`${ base }/v1/local/recovery/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401);
    const recovered = await fetch(`${ base }/v1/local/recovery/device`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-sulla-files-token': config.localToken }, body,
    });
    assert.equal(recovered.status, 200); assert.deepEqual(await recovered.json(), { recovered: 1 });
    assert.equal(initialized, true); assert.equal(keyring.unlocked, true);
    assert.deepEqual(await (await fetch(`${ base }/v1/local/identity`, { headers: { 'x-sulla-files-token': config.localToken } })).json(), { principalId: 'vault-principal' });
    assert.ok(recoveryRequest.every(byte => byte === 0));
    keyring.close();
    await assert.rejects(keyring.unlock(oldMaster, signing));
    await keyring.unlock(replacementMaster, signing);
    assert.deepEqual(Buffer.from((await keyring.keys('new')).data), Buffer.from(original.data));
  } finally {
    original.data.fill(0); original.dedup.fill(0); keyring.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('malformed bootstrap never reflects secrets and failed shutdown still scrubs key memory', async() => {
  const db = database([]); const keyring = new FilesKeyring(db);
  const config:any = { keyring, chunkRoot: '/tmp/sulla-synthetic-keyring', capabilitySigningKey: signing, localToken: 'synthetic-local-token', mode: 'desktop' };
  const server = createApp(db, config, undefined, undefined, undefined, undefined, async() => { await Promise.resolve(); throw new Error('synthetic shutdown failure') }).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${ (server.address() as any).port }`;
  const headers = { 'content-type': 'application/json', 'x-sulla-files-token': config.localToken };
  try {
    const malformed = await fetch(`${ base }/v1/local/unlock`, { method: 'POST', headers, body: '{"masterKey":"synthetic-sensitive-value",broken' });
    assert.equal(malformed.status, 400); assert.ok(!(await malformed.text()).includes('synthetic-sensitive-value'));
    assert.equal((await fetch(`${ base }/v1/local/unlock`, { method: 'POST', headers, body: JSON.stringify({ masterKey: randomBytes(32).toString('base64') }) })).status, 200);
    assert.equal((await fetch(`${ base }/v1/local/lock`, { method: 'POST', headers })).status, 500);
    assert.equal(keyring.unlocked, false);
    assert.equal((await (await fetch(`${ base }/healthz`)).json()).locked, true);
  } finally { keyring.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
});

test('watched folder cannot overlap private storage through paths or symlinks', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-storage-boundary-'));
  const files = join(root, 'Files'); const data = join(root, 'private'); const chunks = join(data, 'chunks');
  try {
    await mkdir(files); await mkdir(chunks, { recursive: true });
    await assertSeparateStorageRoots(files, data, chunks);
    await assert.rejects(assertSeparateStorageRoots(root, data, chunks), /must not overlap/);
    await assert.rejects(assertSeparateStorageRoots(chunks, data, chunks), /must not overlap/);
    await symlink(data, join(root, 'alias'));
    await assert.rejects(assertSeparateStorageRoots(join(root, 'alias'), data, chunks), /must not overlap/);
  } finally { await rm(root, { recursive: true }) }
});
