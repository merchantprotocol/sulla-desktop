import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  generateX25519RecipientKeyPair,
  rewrapFilesKeyBundleForDevice,
} from '@sulla/vault-crypto';
import pg from 'pg';

import { createApp } from './app.js';
import { issueCapabilityToken } from './auth.js';
import { encryptChunk } from './crypto.js';
import { migrate } from './db.js';
import { type FilesKeyBundleAuthority, type StoredFilesKeyBundle } from './keyBundleRecovery.js';
import { SecureCollectionKeyExchange } from './keyExchange.js';
import { FilesKeyring } from './keyring.js';
import { LocalFilesManager } from './localManager.js';
import { FileResidencyManager } from './residency.js';
import { HttpResidencyTransport, loadResidencySyncBundle } from './residencyHttp.js';
import { Store } from './store.js';

import type { Config } from './config.js';
import type { Server } from 'node:http';

const run = promisify(execFile);

test('real residency handlers verify remote custody before eviction and hydrate exact bytes', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-residency-acceptance-'));
  const cluster = join(root, 'postgres');
  const port = 46_000 + (process.pid % 10_000);
  const localMaster = randomBytes(32);
  const remoteMaster = randomBytes(32);
  const signingKey = randomBytes(32);
  const authorityKeys = await generateX25519RecipientKeyPair();
  let admin:pg.Pool | undefined;
  let localDb:pg.Pool | undefined;
  let remoteDb:pg.Pool | undefined;
  let localKeyring:FilesKeyring | undefined;
  let remoteKeyring:FilesKeyring | undefined;
  let manager:LocalFilesManager | undefined;
  let localServer:Server | undefined;
  let remoteServer:Server | undefined;
  let registered:StoredFilesKeyBundle | undefined;

  try {
    await run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    await run('pg_ctl', ['-D', cluster, '-w', 'start', '-o', `-F -p ${ port } -h 127.0.0.1 -k ${ root }`, '-l', join(root, 'postgres.log')]);
    admin = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ port }/postgres` });
    await admin.query('CREATE DATABASE files_local_acceptance');
    await admin.query('CREATE DATABASE files_remote_acceptance');
    localDb = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ port }/files_local_acceptance` });
    remoteDb = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ port }/files_remote_acceptance` });
    await Promise.all([migrate(localDb), migrate(remoteDb)]);

    localKeyring = new FilesKeyring(localDb);
    remoteKeyring = new FilesKeyring(remoteDb);
    await Promise.all([
      localKeyring.unlock(localMaster, signingKey),
      remoteKeyring.unlock(remoteMaster, signingKey),
    ]);

    await remoteDb.query('CREATE TABLE users(id TEXT PRIMARY KEY, disabled_at TIMESTAMPTZ)');
    await remoteDb.query("INSERT INTO users(id) VALUES('synthetic-vault-principal')");
    const remoteConfig:Config = {
      keyring:              remoteKeyring,
      port:                 0,
      databaseUrl:          `postgresql://postgres@127.0.0.1:${ port }/files_remote_acceptance`,
      chunkRoot:            join(root, 'remote-chunks'),
      dataRoot:             join(root, 'remote-data'),
      caseInsensitiveRoot:  false,
      capabilitySigningKey: signingKey,
      mode:                 'server',
      deviceId:             'synthetic-remote-device',
      userId:               'synthetic-vault-principal',
      cloudUrl:             'https://invalid.test',
      paused:               true,
      modelDir:             join(root, 'unused-remote-model'),
    };
    const remoteApp = createApp(remoteDb, remoteConfig, undefined, remoteDb);
    let remoteFault:'corrupt' | 'missing' | undefined;
    const remoteRequests:{ method: string; path: string; subject?: string }[] = [];
    remoteServer = createServer((request, response) => {
      const authorization = request.headers.authorization;
      let subject:string | undefined;
      if (authorization?.startsWith('Bearer ')) {
        subject = JSON.parse(Buffer.from(authorization.slice('Bearer '.length).split('.')[1], 'base64url').toString('utf8')).sub;
      }
      remoteRequests.push({ method: request.method ?? '', path: request.url ?? '', subject });
      if (request.method === 'GET' && request.url?.startsWith('/v1/chunks/') && remoteFault) {
        if (remoteFault === 'missing') {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end('{"error":"synthetic missing remote chunk"}');
        } else {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          response.end('corrupt');
        }
        return;
      }
      remoteApp(request, response);
    });
    await listen(remoteServer);
    const remoteAddress = remoteServer.address();
    assert(remoteAddress && typeof remoteAddress === 'object');
    const remoteUrl = `http://127.0.0.1:${ remoteAddress.port }`;

    const filesRoot = join(root, 'local-files');
    const localDataRoot = join(root, 'local-data');
    const localChunkRoot = join(root, 'local-chunks');
    await Promise.all([mkdir(join(filesRoot, 'Proof'), { recursive: true }), mkdir(localDataRoot), mkdir(localChunkRoot)]);
    const path = 'Proof/residency.txt';
    const bytes = Buffer.from('authenticated residency round trip\nwith synthetic keys only\n');
    await writeFile(join(filesRoot, path), bytes, { mode: 0o600 });
    const localConfig:Config = {
      keyring:              localKeyring,
      port:                 0,
      databaseUrl:          `postgresql://postgres@127.0.0.1:${ port }/files_local_acceptance`,
      chunkRoot:            localChunkRoot,
      dataRoot:             localDataRoot,
      filesRoot,
      caseInsensitiveRoot:  false,
      capabilitySigningKey: signingKey,
      mode:                 'desktop',
      deviceId:             'synthetic-local-device',
      userId:               'synthetic-vault-principal',
      serverUrl:            remoteUrl,
      cloudUrl:             'https://invalid.test',
      paused:               true,
      modelDir:             join(root, 'unused-local-model'),
    };
    manager = new LocalFilesManager(localDb, localConfig);
    await manager.initialize();
    const file = (await localDb.query(
      `SELECT f.id,f.collection_id,f.current_version_id,v.manifest_hash,m.chunk_ids
         FROM files f JOIN file_versions v ON v.id=f.current_version_id JOIN manifests m ON m.hash=v.manifest_hash
        WHERE f.path=$1`,
      [path],
    )).rows[0];
    assert(file);
    const chunkId = String(file.chunk_ids[0]);

    const authority:FilesKeyBundleAuthority = {
      custodyRecipient: (context) => {
        assert.equal(context.principalId, 'synthetic-vault-principal');
        return Promise.resolve({ keyId: 'synthetic-authority-key', publicKey: authorityKeys.publicKey });
      },
      registerBundle: (bundle) => {
        assert.equal(bundle.authorityKeyId, 'synthetic-authority-key');
        registered = bundle;
        return Promise.resolve();
      },
      authorizeDeviceRecovery: async({ context, devicePublicKey }) => {
        assert(registered);
        assert.deepEqual(registered.context, context);
        return rewrapFilesKeyBundleForDevice(
          registered.envelope,
          context,
          authorityKeys.publicKey,
          authorityKeys.privateKey,
          devicePublicKey,
        );
      },
    };
    const keyExchange = new SecureCollectionKeyExchange(localDb, localKeyring, authority);
    const transport = new HttpResidencyTransport({
      serverUrl:            remoteUrl,
      principalId:          () => localConfig.userId,
      deviceId:             localConfig.deviceId,
      capabilitySigningKey: signingKey,
      bundleFor:            version => loadResidencySyncBundle(localDb!, version),
    });
    const residency = new FileResidencyManager(
      localDb,
      new Store(localChunkRoot),
      localKeyring,
      keyExchange,
      transport,
      manager.mutations,
    );
    const localApp = createApp(localDb, localConfig, manager, undefined, undefined, undefined, undefined, undefined, residency);
    localServer = localApp.listen(0, '127.0.0.1');
    await listening(localServer);
    const localAddress = localServer.address();
    assert(localAddress && typeof localAddress === 'object');
    const localUrl = `http://127.0.0.1:${ localAddress.port }`;
    const token = issueCapabilityToken({
      sub: 'synthetic-vault-principal', device_id: localConfig.deviceId, scopes: ['files/*'],
    }, signingKey);
    const auth = { authorization: `Bearer ${ token }`, 'content-type': 'application/json' };
    const setResidency = async(desiredState:'local' | 'online-only') => {
      const response = await fetch(`${ localUrl }/v1/files/${ file.id }/residency`, {
        method: 'POST', headers: auth, body: JSON.stringify({ desiredState }),
      });
      return { response, body: await response.json() };
    };

    remoteFault = 'corrupt';
    let result = await setResidency('online-only');
    assert.equal(result.response.status, 409);
    assert.match(result.body.error, /remote chunk|ciphertext/i);
    assert.deepEqual(await readFile(join(filesRoot, path)), bytes, 'corrupt remote data must not evict the local file');
    assert.equal((await localDb.query('SELECT count(*)::int AS count FROM file_remote_version_proofs WHERE version_id=$1', [file.current_version_id])).rows[0].count, 0);

    remoteFault = 'missing';
    result = await setResidency('online-only');
    assert.equal(result.response.status, 409);
    assert.match(result.body.error, /404|missing remote chunk/i);
    assert.deepEqual(await readFile(join(filesRoot, path)), bytes, 'missing remote data must not evict the local file');

    remoteFault = undefined;
    result = await setResidency('online-only');
    assert.equal(result.response.status, 200);
    assert.equal(result.body.state, 'online-only');
    await assert.rejects(access(join(filesRoot, path)), { code: 'ENOENT' });
    assert.equal((await localDb.query('SELECT deleted_at IS NULL AS live FROM files WHERE id=$1', [file.id])).rows[0].live, true);
    assert.equal((await remoteDb.query('SELECT current_version_id=$2 AS committed FROM files WHERE id=$1', [file.id, file.current_version_id])).rows[0].committed, true);
    const remoteStore = new Store(remoteConfig.chunkRoot);
    const localStore = new Store(localChunkRoot);
    assert.equal(await remoteStore.has(file.collection_id, chunkId), true);
    assert.equal(await localStore.has(file.collection_id, chunkId), false, 'verified online-only data should release its local encrypted cache');

    await manager.rescan();
    const afterRescan = await fetch(`${ localUrl }/v1/files?collectionId=${ file.collection_id }`, { headers: auth });
    assert.equal(afterRescan.status, 200);
    const listed = await afterRescan.json();
    assert.deepEqual(listed.map((item:any) => ({ id: item.id, syncState: item.sync_state })), [{ id: file.id, syncState: 'online-only' }]);
    assert.equal((await localDb.query('SELECT deleted_at IS NULL AS live FROM files WHERE id=$1', [file.id])).rows[0].live, true);

    const remoteCiphertext = await remoteStore.get(file.collection_id, chunkId);
    const corruptEnvelope = JSON.parse(remoteCiphertext.toString('utf8'));
    corruptEnvelope.ciphertext = `${ corruptEnvelope.ciphertext[0] === 'A' ? 'B' : 'A' }${ corruptEnvelope.ciphertext.slice(1) }`;
    const corruptCiphertext = Buffer.from(JSON.stringify(corruptEnvelope));
    assert.equal(corruptCiphertext.length, remoteCiphertext.length);
    assert.equal(await localStore.put(file.collection_id, chunkId, corruptCiphertext), true);
    result = await setResidency('local');
    assert.equal(result.response.status, 409);
    await assert.rejects(access(join(filesRoot, path)), { code: 'ENOENT' });
    await localStore.delete(file.collection_id, chunkId);

    const keys = await localKeyring.copyKeys(file.collection_id);
    let alternateCiphertext:Buffer;
    try {
      alternateCiphertext = await encryptChunk(bytes, keys.data, chunkId);
    } finally {
      keys.data.fill(0);
      keys.dedup.fill(0);
    }
    assert.notDeepEqual(alternateCiphertext, remoteCiphertext);
    assert.equal(alternateCiphertext.length, remoteCiphertext.length);
    assert.equal(await localStore.put(file.collection_id, chunkId, alternateCiphertext), true);

    result = await setResidency('local');
    assert.equal(result.response.status, 200);
    assert.equal(result.body.state, 'local');
    assert.deepEqual(await readFile(join(filesRoot, path)), bytes);
    assert.deepEqual(await localStore.get(file.collection_id, chunkId), alternateCiphertext, 'hydration must preserve an authenticated immutable cache winner');
    const preview = await fetch(`${ localUrl }/v1/files/${ file.id }/preview`, { headers: auth });
    assert.equal(preview.status, 200);
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes, 'hydration must restore handler-readable bytes');
    assert.equal((await localDb.query('SELECT count(*)::int AS count FROM watched_folder_state WHERE file_id=$1 AND path=$2', [file.id, path])).rows[0].count, 1);

    assert(remoteRequests.some(request => request.method === 'POST' && request.path === '/v1/versions/prepare'));
    assert(remoteRequests.some(request => request.method === 'PUT' && request.path.startsWith('/v1/chunks/')));
    assert(remoteRequests.some(request => request.method === 'POST' && request.path === '/v1/versions/commit'));
    assert(remoteRequests.some(request => request.method === 'GET' && request.path === `/v1/versions/${ file.current_version_id }`));
    assert(remoteRequests.every(request => request.subject === 'synthetic-vault-principal'), 'every remote request must carry the adopted Vault principal');
  } finally {
    await close(localServer);
    await close(remoteServer);
    await manager?.close();
    localKeyring?.close();
    remoteKeyring?.close();
    localMaster.fill(0);
    remoteMaster.fill(0);
    signingKey.fill(0);
    authorityKeys.privateKey.fill(0);
    await localDb?.end();
    await remoteDb?.end();
    await admin?.end();
    await run('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop']).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function listen(server:Server):Promise<void> {
  server.listen(0, '127.0.0.1');
  return listening(server);
}

function listening(server:Server):Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) });
}

function close(server?:Server):Promise<void> {
  return new Promise(resolve => server?.close(() => resolve()) ?? resolve());
}
