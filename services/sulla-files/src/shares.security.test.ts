import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import test from 'node:test';

import { encrypt, encryptChunk } from './crypto.js';
import { FilesKeyring } from './keyring.js';
import { SharesService } from './shares.js';

function encodedPassword(password:string) {
  const salt = Buffer.from('synthetic-share-salt');
  return `${ salt.toString('base64url') }:${ scryptSync(password, salt, 32).toString('base64url') }`;
}

function service(row?:Record<string, unknown>) {
  const writes:string[] = [];
  const query = (sql:string) => { if (sql.startsWith('SELECT * FROM file_share_links WHERE id=$1')) return Promise.resolve({ rows: row ? [row] : [] }); writes.push(sql); return Promise.resolve({ rows: [], rowCount: 1 }) };
  const db = {
    connect: () => Promise.resolve({ query, release: () => {} }),
    query,
  };
  return { shares: new SharesService(db as any, { mode: 'desktop' } as any, {} as any), writes };
}

async function status(operation:()=>Promise<unknown>) { try { await operation(); return 200 } catch (error:any) { return error.status } }

test('share authorization fails closed for unknown, revoked, expired, password, and download policy boundaries', async() => {
  assert.equal(await status(() => service().shares.authorize('missing', {})), 404);
  assert.equal(await status(() => service({ id: 'revoked', revoked_at: new Date().toISOString() }).shares.authorize('revoked', {})), 404);
  assert.equal(await status(() => service({ id: 'expired', expires_at: new Date(Date.now() - 1_000).toISOString() }).shares.authorize('expired', {})), 404);

  const protectedRow = { id: 'protected', display_name: 'Synthetic file', mime: 'text/plain', target_type: 'file', access_mode: 'view', password_protected: true, password_hash: encodedPassword('correct horse battery staple'), display_sharer_name: true };
  assert.equal(await status(() => service(protectedRow).shares.authorize('protected', {})), 401);
  assert.equal(await status(() => service(protectedRow).shares.authorize('protected', { password: 'wrong password' })), 401);
  assert.equal(await status(() => service(protectedRow).shares.authorize('protected', { password: 'correct horse battery staple', wantsDownload: true })), 403);

  const allowed = service({ ...protectedRow, access_mode: 'download' });
  assert.equal(await status(() => allowed.shares.authorize('protected', { password: 'correct horse battery staple', wantsDownload: true })), 200);
  assert.equal(allowed.writes.some(sql => sql.includes('view_count=view_count+1')), true);
  assert.equal(allowed.writes.some(sql => sql.includes('file_share_events')), true);
});

test('restoring a password-protected link requires password re-entry before cloud registration', async() => {
  const protectedRow = { id: 'protected', revoked_at: new Date().toISOString(), password_protected: true, password_hash: encodedPassword('correct horse battery staple') };
  const shares = service(protectedRow).shares;

  assert.equal(await status(() => shares.restore({ user: 'synthetic-owner', device: 'synthetic-device' }, 'protected', 'synthetic-cloud-token')), 401);
  assert.equal(await status(() => shares.restore({ user: 'synthetic-owner', device: 'synthetic-device' }, 'protected', 'synthetic-cloud-token', 'wrong password')), 401);
});

test('share policy transitions for the same link are serialized', async() => {
  const shares = service().shares as any; const order:string[] = [];
  let releaseFirst:()=>void = () => {}; let markEntered:()=>void = () => {};
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve });
  const entered = new Promise<void>(resolve => { markEntered = resolve });
  const first = shares.withLinkLock('same-link', async() => { order.push('first:start'); markEntered(); await firstGate; order.push('first:end') });

  await entered;
  const second = shares.withLinkLock('same-link', () => { order.push('second'); return Promise.resolve() });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('a lost create POST response leaves durable revocation and attempts remote deletion', async() => {
  const queries:{ sql: string; params?: unknown[] }[] = []; const cloudCalls:string[] = [];
  let shareId = ''; let checkedOut = false; let releasedWith:Error | undefined;
  const clientQuery = (sql:string, params?:unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO file_share_links')) shareId = String(params?.[0]);
    return Promise.resolve({ rows: [], rowCount: 1 });
  };
  const db = {
    connect: () => {
      assert.equal(checkedOut, false, 'a one-client pool cannot satisfy a nested checkout'); checkedOut = true;
      return Promise.resolve({ query: clientQuery, release: (error?:Error) => { checkedOut = false; releasedWith = error } });
    },
    query:   (sql:string, params?:unknown[]) => {
      assert.equal(checkedOut, false, 'locked work must use the checked-out advisory-lock client');
      queries.push({ sql, params });
      if (sql.startsWith('SELECT id,collection_id,path,mime FROM files')) return Promise.resolve({ rows: [{ id: 'synthetic-file', collection_id: 'synthetic-collection', path: 'safe/example.txt', mime: 'text/plain' }] });
      throw new Error(`locked operation leaked onto the pool: ${ sql }`);
    },
  };
  const shares = new SharesService(db as any, { mode: 'desktop' } as any, {} as any) as any;
  shares.cloud = (path:string, _token:string, init:RequestInit = {}) => {
    cloudCalls.push(`${ init.method ?? 'GET' } ${ path }`);
    throw new Error(init.method === 'POST' ? 'synthetic response lost after commit' : 'synthetic delete unconfirmed');
  };

  await assert.rejects(() => shares.create(
    { user: 'synthetic-owner', device: 'synthetic-device' },
    { fileId: 'synthetic-file', keepAvailable: false },
    'synthetic-cloud-token',
  ), /response lost/);

  assert.deepEqual(cloudCalls, ['POST /shares', `DELETE /shares/${ shareId }`]);
  const insert = queries.find(item => item.sql.includes('INSERT INTO file_share_links'));
  assert.match(insert?.sql ?? '', /revoked_at,reconciliation_required,reconciliation_action,reconciliation_updated_at/);
  assert.equal(queries.some(item => item.sql.startsWith('DELETE FROM file_share_links')), false);
  assert.equal(queries.some(item => item.sql.includes('reconciliation_required=$2') && item.params?.[1] === true), true);
  assert.equal(checkedOut, false);
  assert.equal(releasedWith, undefined);
});

test('an advisory unlock failure destroys the checked-out client', async() => {
  const unlockError = new Error('synthetic advisory unlock failure'); let releasedWith:Error | undefined;
  const db = {
    connect: () => Promise.resolve({
      query:   (sql:string) => sql.includes('pg_advisory_unlock') ? Promise.reject(unlockError) : Promise.resolve({ rows: [] }),
      release: (error?:Error) => { releasedWith = error },
    }),
    query: () => { throw new Error('unexpected pooled query') },
  };
  const shares = new SharesService(db as any, { mode: 'desktop' } as any, {} as any) as any;

  await assert.rejects(() => shares.withLinkLock('synthetic-link', () => Promise.resolve()), /advisory unlock failure/);
  assert.equal(releasedWith, unlockError);
});

test('enabling keep-available confirms PATCH before cold-keyring upload on the locked client', async() => {
  const master = Buffer.alloc(32, 1); const dataKey = Buffer.alloc(32, 2); const dedupKey = Buffer.alloc(32, 3);
  const collectionId = 'synthetic-collection'; const chunkId = 'a'.repeat(64);
  const dataEnvelope = await encrypt(dataKey, master, `sulla:files:data-key:v1:${ collectionId }`);
  const dedupEnvelope = await encrypt(dedupKey, master, `sulla:files:dedup-key:v1:${ collectionId }`);
  const encryptedChunk = await encryptChunk(Buffer.from('synthetic share content'), dataKey, chunkId);
  let checkedOut = false; const shareId = 'cold-link'; const cloudCalls:string[] = [];
  const shareRow:Record<string, unknown> = {
    id:                  shareId,
    owner_user_id:       'synthetic-owner',
    target_type:         'file',
    file_id:             'synthetic-file',
    display_name:        'example.txt',
    mime:                'text/plain',
    access_mode:         'view',
    password_protected:  false,
    password_hash:       null,
    expires_at:          null,
    keep_available:      false,
    keep_until:          null,
    display_sharer_name: true,
    revoked_at:          null,
  };
  const clientQuery = (sql:string, params?:unknown[]) => {
    if (sql.startsWith('SELECT * FROM file_share_links WHERE id=$1')) return Promise.resolve({ rows: [shareRow] });
    if (sql.startsWith('SELECT * FROM files WHERE id=$1')) return Promise.resolve({ rows: [{ id: 'synthetic-file', path: 'safe/example.txt', mime: 'text/plain', current_version_id: 'synthetic-version' }] });
    if (sql.startsWith('SELECT 1 FROM files_protected_files')) return Promise.resolve({ rows: [], rowCount: 0 });
    if (sql.startsWith('SELECT v.chunk_collection_id')) return Promise.resolve({ rows: [{ chunk_collection_id: collectionId, chunk_ids: [chunkId] }] });
    if (sql.startsWith('SELECT data_key,dedup_key')) return Promise.resolve({ rows: [{ data_key: dataEnvelope, dedup_key: dedupEnvelope }] });
    if (sql.includes('reconciliation_required=TRUE')) Object.assign(shareRow, { revoked_at: new Date().toISOString(), reconciliation_required: true, reconciliation_action: 'delete' });
    if (sql.includes('SET access_mode=$2')) Object.assign(shareRow, { keep_available: params?.[5], revoked_at: null, reconciliation_required: false, reconciliation_action: null });
    return Promise.resolve({ rows: [], rowCount: 1 });
  };
  const db = {
    connect: () => {
      assert.equal(checkedOut, false); checkedOut = true;
      return Promise.resolve({ query: clientQuery, release: () => { checkedOut = false } });
    },
    query: (sql:string) => {
      assert.equal(checkedOut, false, 'cold key lookup must not borrow another pool client');
      throw new Error(`unexpected pooled query ${ sql }`);
    },
  };
  const keyring = new FilesKeyring(db as any); (keyring as any).master = Buffer.from(master);
  const shares = new SharesService(db as any, { mode: 'desktop', keyring } as any, { get: () => Promise.resolve(encryptedChunk) } as any) as any;
  shares.cloud = (path:string, _token:string, init:RequestInit = {}) => {
    cloudCalls.push(`${ init.method ?? 'GET' } ${ path }`);
    if (init.method === 'PATCH') {
      assert.equal(shareRow.reconciliation_required, true);
      return { url: 'https://synthetic.invalid/s/cold', accessMode: 'view', passwordProtected: false, expiresAt: null, keepAvailable: true, keepUntil: null, displaySharerName: true };
    }
    if (init.method === 'PUT') { assert.equal(cloudCalls[0], `PATCH /shares/${ shareId }`); return {} }
    throw new Error(`unexpected cloud call ${ init.method ?? 'GET' } ${ path }`);
  };

  await shares.update({ user: 'synthetic-owner', device: 'synthetic-device' }, shareId, { keepAvailable: true }, 'synthetic-cloud-token');
  assert.deepEqual(cloudCalls, [`PATCH /shares/${ shareId }`, `PUT /shares/${ shareId }/content`]);
  assert.equal(checkedOut, false);
  keyring.close(); master.fill(0); dataKey.fill(0); dedupKey.fill(0);
});

test('a pending delete selected while restore holds the link lock re-reads state and skips the restored link', async() => {
  const identity = { user: 'synthetic-owner', device: 'synthetic-device' };
  const row:Record<string, unknown> = {
    id:                      'restored-link',
    owner_user_id:           identity.user,
    revoked_at:              new Date().toISOString(),
    reconciliation_required: true,
    reconciliation_action:  'delete',
    password_protected:      false,
    target_type:             'file',
    display_name:            'Synthetic file',
    mime:                    'text/plain',
    access_mode:             'view',
    expires_at:              null,
    display_sharer_name:     true,
    device_id:               identity.device,
    relay_secret:            null,
    asset_kind:              'file',
    capture_metadata:        {},
  };
  let markSelected:()=>void = () => {}; const selected = new Promise<void>(resolve => { markSelected = resolve });
  const clientQuery = (sql:string, params?:unknown[]) => {
    if (sql.includes('SELECT owner_user_id,reconciliation_required,reconciliation_action')) return Promise.resolve({ rows: [{ owner_user_id: row.owner_user_id, reconciliation_required: row.reconciliation_required, reconciliation_action: row.reconciliation_action }] });
    if (sql.startsWith('SELECT * FROM file_share_links WHERE id=$1 AND owner_user_id=$2')) return Promise.resolve({ rows: [row] });
    if (sql.includes('reconciliation_required=$2')) { row.revoked_at ??= new Date().toISOString(); row.reconciliation_required = params?.[1]; row.reconciliation_action = params?.[1] ? 'delete' : null }
    if (sql.includes('SET revoked_at=NULL,public_url=')) { row.revoked_at = null; row.reconciliation_required = false; row.reconciliation_action = null; row.public_url = params?.[1] }
    return Promise.resolve({ rows: [], rowCount: 1 });
  };
  const db = {
    connect: () => Promise.resolve({ query: clientQuery, release: () => {} }),
    query:   (sql:string) => {
      if (sql.includes('SELECT id FROM file_share_links WHERE owner_user_id')) { markSelected(); return Promise.resolve({ rows: row.reconciliation_required ? [{ id: row.id }] : [] }) }
      throw new Error(`locked operation leaked onto the pool: ${ sql }`);
    },
  };
  const shares = new SharesService(db as any, { mode: 'desktop' } as any, {} as any) as any;
  let deleteCalls = 0; let releasePost:()=>void = () => {}; let markPostStarted:()=>void = () => {};
  const postGate = new Promise<void>(resolve => { releasePost = resolve });
  const postStarted = new Promise<void>(resolve => { markPostStarted = resolve });
  shares.cloud = async(path:string, _token:string, init:RequestInit = {}) => {
    if (init.method === 'DELETE') { deleteCalls++; return {} }
    if (init.method === 'POST') {
      markPostStarted(); await postGate;
      return { url: 'https://synthetic.invalid/s/restored-link', accessMode: 'view', passwordProtected: false, expiresAt: null, keepAvailable: false, keepUntil: null, displaySharerName: true };
    }
    throw new Error(`unexpected cloud call ${ init.method ?? 'GET' } ${ path }`);
  };

  const restoring = shares.restore(identity, 'restored-link', 'synthetic-cloud-token');
  await postStarted;
  const reconciling = shares.reconcilePendingDeletes(identity, 'synthetic-cloud-token');
  await selected;
  releasePost();
  await Promise.all([restoring, reconciling]);

  assert.equal(deleteCalls, 1);
  assert.equal(row.revoked_at, null);
  assert.equal(row.reconciliation_required, false);
});
