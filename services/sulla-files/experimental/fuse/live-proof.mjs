#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { networkInterfaces, platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import express from 'express';
import pg from 'pg';

import { createApp } from '../../src/app.ts';
import { migrate } from '../../src/db.ts';
import { FilesKeyring } from '../../src/keyring.ts';
import { LocalFilesManager } from '../../src/localManager.ts';
import { readBoundedResponse } from '../../../../pkg/rancher-desktop/main/sullaFilesBoundedResponse.ts';
import { SullaFilesNativeBroker } from '../../../../pkg/rancher-desktop/main/sullaFilesNativeBroker.ts';
import { SullaFilesSourceGateway } from '../../../../pkg/rancher-desktop/main/sullaFilesSourceGateway.ts';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const port = Number(process.env.SULLA_FILES_PROOF_PORT ?? 48792);
const trace7Mode = process.env.SULLA_FILES_PROOF_TRACE7 ?? '';
if (trace7Mode && !['prepare', 'recover'].includes(trace7Mode)) throw new Error('SULLA_FILES_PROOF_TRACE7 must be prepare or recover');
const trace7Base = join(tmpdir(), 'sulla-files-native-trace7');
const trace7Key = trace7Mode === 'prepare' ? randomUUID() : process.env.SULLA_FILES_PROOF_TRACE7_KEY;
if (trace7Mode && !/^[a-f0-9-]{36}$/.test(trace7Key ?? '')) throw new Error('Trace 7 recovery requires the generated fixture key');
const root = trace7Mode ? join(trace7Base, trace7Key) : await mkdtemp(join(tmpdir(), 'sulla-files-live-proof-'));
const trace7StatePath = join(root, '.sulla-trace7-state.json');
const cluster = join(root, 'postgres');
const sourceRoot = join(root, 'synthetic-source');
const mountRoot = join(root, 'mount');
const proofPath = join(sourceRoot, 'Proof', 'round-trip.txt');
const mountedPath = join(mountRoot, 'Native Sources', 'round-trip.txt');
const containerMountedPath = '/mnt/proof/Native Sources/round-trip.txt';
const fuseContainer = `sulla-files-native-proof-${ process.pid }`;
let databasePort = 50_000 + (process.pid % 10_000);
const originalBytes = 'original synthetic bytes\n';

let admin;
let db;
let fuse;
let keyring;
let manager;
let gateway;
let broker;
let brokerTimer;
let server;
let stopping = false;
let releaseNativeAccess;
let sourceHandle;
let lockedSourceHandle;
let trace7State;
let trace7Armed = false;
let proofMaster;
let signingKey;
let localToken;

const nativeMacProof = process.env.SULLA_FILES_MACOS_NATIVE_PROOF === '1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function assertOwnedDirectory(target, mode = 0o700) {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== mode) {
    throw new Error('Trace 7 fixture directory failed its owner, type, or mode check');
  }
  if (await realpath(target) !== target) throw new Error('Trace 7 fixture directory is not its canonical exact path');
}

async function readTrace7State() {
  await assertOwnedDirectory(trace7Base);
  await assertOwnedDirectory(root);
  const info = await lstat(trace7StatePath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) {
    throw new Error('Trace 7 fixture marker failed its owner, type, or mode check');
  }
  const state = JSON.parse(await readFile(trace7StatePath, 'utf8'));
  if (state.schema !== 1 || state.fixtureKey !== trace7Key || state.phase !== 'published-not-acknowledged') {
    throw new Error('Trace 7 fixture marker does not identify a recoverable harness-created fixture');
  }
  return state;
}

async function writeTrace7State(state, exclusive = false) {
  await assertOwnedDirectory(trace7Base);
  await assertOwnedDirectory(root);
  const bytes = `${ JSON.stringify(state) }\n`;
  if (!exclusive) {
    const info = await lstat(trace7StatePath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) throw new Error('Trace 7 fixture marker changed identity');
  }
  const marker = await open(trace7StatePath, exclusive ? 'wx' : 'r+', 0o600);
  try {
    if (!exclusive) await marker.truncate(0);
    await marker.writeFile(bytes);
    await marker.sync();
  } finally { await marker.close() }
  const directory = await open(root, 'r');
  try { await directory.sync() } finally { await directory.close() }
}

async function initializeTrace7Fixture() {
  if (!trace7Mode) return;
  if (trace7Mode === 'prepare') {
    await mkdir(trace7Base, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(trace7Base);
    await mkdir(root, { mode: 0o700 });
    await assertOwnedDirectory(root);
    trace7State = { schema: 1, fixtureKey: trace7Key, phase: 'initializing' };
    await writeTrace7State(trace7State, true);
    return;
  }
  trace7State = await readTrace7State();
  databasePort = trace7State.databasePort;
}

await initializeTrace7Fixture();

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise });
  return { promise, resolve };
}

function reachableAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find(value => value.family === 'IPv4' && !value.internal && value.address.startsWith('192.168.'));
    if (address) return address.address;
  }
  return '127.0.0.1';
}

function issueProofToken(input, key) {
  const encode = value => Buffer.from(value).toString('base64url');
  const now = Math.floor(Date.now() / 1_000);
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = encode(JSON.stringify({ ...input, v: 1, iss: 'sulla-files', aud: 'sulla-tools', iat: now, exp: now + 3_600, jti: randomUUID() }));
  const signature = createHmac('sha256', key).update(`${ header }.${ payload }`).digest('base64url');
  return `${ header }.${ payload }.${ signature }`;
}

async function waitFor(predicate, message, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(message);
}

async function ordinaryFuseEdit(bytes) {
  if (nativeMacProof) {
    const program = 'import base64,os,sys;p=sys.argv[1];b=base64.b64decode(sys.argv[2]);f=open(p,"r+b");f.truncate(0);f.write(b);f.flush();os.fsync(f.fileno());f.close()';
    await run('docker', ['exec', fuseContainer, 'python3', '-c', program, containerMountedPath, Buffer.from(bytes).toString('base64')]);
    return;
  }
  const handle = await open(mountedPath, 'r+');
  try {
    await handle.truncate(0);
    await handle.write(Buffer.from(bytes), 0);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function mountedBytes() {
  if (!nativeMacProof) return readFile(mountedPath);
  const { stdout } = await run('docker', ['exec', fuseContainer, 'python3', '-c', 'import pathlib,sys;sys.stdout.buffer.write(pathlib.Path(sys.argv[1]).read_bytes())', containerMountedPath], { encoding: 'buffer', maxBuffer: 70 * 1024 * 1024 });
  return stdout;
}

async function snapshot(collectionId) {
  const [source, mounted, files] = await Promise.all([
    readFile(proofPath),
    mountedBytes(),
    manager.fuseSnapshot(collectionId),
  ]);
  return {
    sourceHash: sha256(source),
    mountedHash: sha256(mounted),
    tracked: files.map(file => ({ id: file.id, path: file.path, size: file.size, versionId: file.versionId })),
  };
}

async function selectNativeSource() {
  if (!nativeMacProof) return { sourcePath: proofPath };
  if (platform() !== 'darwin') throw new Error('SULLA_FILES_MACOS_NATIVE_PROOF=1 must run natively on macOS');
  const electron = globalThis[Symbol.for('sulla.files.nativeProof.electron')];
  if (!electron?.app?.whenReady || !electron.dialog?.showOpenDialog) throw new Error('Run the native proof through macos-native-proof-bootstrap.mjs');
  await electron.app.whenReady();
  await electron.dialog.showMessageBox({
    type: 'info', title: 'Synthetic native Files proof',
    message: 'Select the pre-created round-trip.txt file in the folder opened by the next dialog.',
    detail: 'The harness rejects every other selection. No existing file or Sulla application data is accepted.',
  });
  const picked = await electron.dialog.showOpenDialog({
    title: 'Select the synthetic round-trip.txt proof file', defaultPath: proofPath,
    properties: ['openFile'], securityScopedBookmarks: true,
  });
  if (picked.canceled || !picked.filePaths[0] || !picked.bookmarks?.[0]) throw new Error('The native proof requires one chooser-issued security-scoped bookmark');
  if (await realpath(picked.filePaths[0]) !== await realpath(proofPath)) throw new Error('The selected file is not the isolated synthetic proof file');
  const release = electron.app.startAccessingSecurityScopedResource(picked.bookmarks[0]);
  if (typeof release !== 'function') throw new Error('macOS did not grant security-scoped access to the synthetic proof file');
  return { sourcePath: picked.filePaths[0], release };
}

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  if (brokerTimer) clearInterval(brokerTimer);
  if (nativeMacProof) {
    const ownedContainer = trace7Mode === 'recover' ? trace7State?.fuseContainer : fuseContainer;
    if (typeof ownedContainer === 'string' && /^sulla-files-native-proof-\d+$/.test(ownedContainer)) {
      await run('docker', ['stop', '--time', '5', ownedContainer]).catch(() => undefined);
    }
  }
  else {
    await run('fusermount3', ['-u', mountRoot]).catch(() => undefined);
    if (fuse?.exitCode === null) fuse.kill('SIGTERM');
  }
  await broker?.suspendAndDrain(() => gateway.lock()).catch(() => undefined);
  await manager?.close().catch(() => undefined);
  await gateway?.stop().catch(() => undefined);
  await new Promise(resolvePromise => server ? server.close(resolvePromise) : resolvePromise());
  keyring?.close();
  await db?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await run('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']).catch(() => undefined);
  releaseNativeAccess?.();
  if (trace7Mode) {
    await assertOwnedDirectory(trace7Base);
    await assertOwnedDirectory(root);
  }
  await rm(root, { recursive: true, force: true });
  if (trace7Mode && !(await readdir(trace7Base)).length) await rmdir(trace7Base).catch(() => undefined);
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());

try {
  if (trace7Mode !== 'recover') {
    await Promise.all([mkdir(join(sourceRoot, 'Proof'), { recursive: true, mode: 0o700 }), mkdir(mountRoot, { recursive: true, mode: 0o700 })]);
    await writeFile(proofPath, originalBytes, { mode: 0o600, flag: 'wx' });
    await run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres', '--no-locale']);
    await run('pg_ctl', ['-D', cluster, '-w', 'start', '-o', `-F -p ${ databasePort } -h 127.0.0.1 -k ${ root }`, '-l', join(root, 'postgres.log')]);
    admin = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ databasePort }/postgres` });
    await admin.query('CREATE DATABASE files_fuse_live_proof');
    proofMaster = randomBytes(32);
    signingKey = randomBytes(32);
    localToken = randomBytes(32).toString('base64url');
  } else {
    const sourceInfo = await lstat(proofPath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.uid !== process.getuid() || (sourceInfo.mode & 0o777) !== 0o600) {
      throw new Error('Persisted synthetic source failed its owner, type, or mode check');
    }
    await run('pg_isready', ['-h', '127.0.0.1', '-p', String(databasePort)]).catch(async() => {
      await run('pg_ctl', ['-D', cluster, '-w', 'start', '-o', `-F -p ${ databasePort } -h 127.0.0.1 -k ${ root }`, '-l', join(root, 'postgres.log')]);
    });
    proofMaster = Buffer.from(trace7State.proofMaster, 'base64');
    signingKey = Buffer.from(trace7State.signingKey, 'base64');
    localToken = trace7State.localToken;
  }
  const databaseUrl = `postgresql://postgres@127.0.0.1:${ databasePort }/files_fuse_live_proof`;
  db = new pg.Pool({ connectionString: databaseUrl });
  if (trace7Mode !== 'recover') await migrate(db);
  keyring = new FilesKeyring(db);
  await keyring.unlock(Buffer.from(proofMaster), signingKey);
  const config = {
    keyring,
    port,
    databaseUrl,
    chunkRoot: join(root, 'chunks'),
    dataRoot: join(root, 'data'),
    filesRoot: undefined,
    caseInsensitiveRoot: false,
    capabilitySigningKey: signingKey,
    mode: 'desktop',
    deviceId: 'synthetic-fuse-device',
    userId: 'synthetic-fuse-owner',
    cloudUrl: 'https://invalid.test',
    paused: false,
    modelDir: join(root, 'unused-model'),
    fileRoots: [],
    fuseExperiment: true,
    localToken,
  };
  manager = new LocalFilesManager(db, config);
  await manager.initialize();
  if (trace7Mode === 'recover') await manager.revalidateNativeSessions([]);
  const collectionId = await manager.nativeCollectionId();
  const token = issueProofToken({ sub: config.userId, device_id: config.deviceId, scopes: ['files/*'] }, signingKey);
  const fuseTokenPath = join(root, 'fuse-token');
  await writeFile(fuseTokenPath, token, { mode: 0o600 });
  const filesApp = createApp(db, config, manager);
  const app = express();
  let runConcurrentConflict;
  let runLockDrain;
  let runSessionRecovery;
  let runInterruptedPublication;

  app.get('/proof-control/', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Synthetic Files FUSE proof</title><style>body{margin:0;background:#111;color:#ddd;font:14px system-ui}header{display:flex;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid #444;flex-wrap:wrap}button{padding:7px 10px}#result{white-space:pre-wrap;color:#9dd;padding-left:8px}iframe{width:100%;height:calc(100vh - 96px);border:0}</style></head><body><header><strong>Synthetic Files + FUSE proof</strong><button id="edit">Ordinary FUSE edit</button><button id="external">External source edit</button><button id="conflict">Concurrent conflict</button><button id="lock">Lock + drain</button><button id="recover">Reselect + recover</button>${ trace7Mode === 'prepare' ? '<button id="trace7">Trace 7 interrupt</button>' : '' }<button id="reset">Reset source</button><button id="status">Status</button><button id="stop">Stop + clean</button><span id="result">Ready</span></header><iframe id="files"></iframe><script type="module">const frame=document.querySelector('#files');const result=document.querySelector('#result');const session=()=>frame.contentWindow.postMessage({type:'sulla:files-session',token:${ JSON.stringify(token) },orgId:'synthetic-proof',email:'Synthetic proof'},location.origin);const call=async path=>{result.textContent='Running…';const response=await fetch('/proof-control/'+path,{method:'POST'});result.textContent=JSON.stringify(await response.json(),null,2)};document.querySelector('#edit').onclick=()=>call('fuse-edit');document.querySelector('#external').onclick=()=>call('external-edit');document.querySelector('#conflict').onclick=()=>call('concurrent-conflict');document.querySelector('#lock').onclick=()=>call('lock-drain');document.querySelector('#recover').onclick=()=>call('session-recovery');document.querySelector('#trace7')?.addEventListener('click',()=>call('trace7-interrupt'));document.querySelector('#reset').onclick=()=>call('reset');document.querySelector('#status').onclick=()=>call('status');document.querySelector('#stop').onclick=()=>call('stop');addEventListener('message',event=>{if(event.origin===location.origin&&event.source===frame.contentWindow&&event.data?.type==='sulla:files-ready')session()});frame.addEventListener('load',session,{once:true});frame.src='/files-proof/';</script></body></html>`);
  });
  app.post('/proof-control/fuse-edit', async(_request, response, next) => {
    try { await ordinaryFuseEdit(`ordinary FUSE edit ${ new Date().toISOString() }\n`); response.json(await snapshot(collectionId)) } catch (error) { next(error) }
  });
  app.post('/proof-control/external-edit', async(_request, response, next) => {
    try { await writeFile(proofPath, `external source edit ${ new Date().toISOString() }\n`); response.json(await snapshot(collectionId)) } catch (error) { next(error) }
  });
  app.post('/proof-control/reset', async(_request, response, next) => {
    try { await writeFile(proofPath, originalBytes); response.json(await snapshot(collectionId)) } catch (error) { next(error) }
  });
  app.post('/proof-control/status', async(_request, response, next) => {
    try { response.json(await snapshot(collectionId)) } catch (error) { next(error) }
  });
  app.post('/proof-control/concurrent-conflict', async(_request, response) => {
    if (!runConcurrentConflict) return response.status(503).json({ error: 'proof_not_ready' });
    try { response.json(await runConcurrentConflict()) } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : 'concurrent_conflict_failed' });
    }
  });
  app.post('/proof-control/lock-drain', async(_request, response) => {
    if (!runLockDrain) return response.status(503).json({ error: 'proof_not_ready' });
    try { response.json(await runLockDrain()) } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : 'lock_drain_failed' });
    }
  });
  app.post('/proof-control/session-recovery', async(_request, response) => {
    if (!runSessionRecovery) return response.status(503).json({ error: 'proof_not_ready' });
    try { response.json(await runSessionRecovery()) } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : 'session_recovery_failed' });
    }
  });
  app.post('/proof-control/trace7-interrupt', async(_request, response) => {
    if (!runInterruptedPublication) return response.status(503).json({ error: 'trace7_not_ready' });
    try { await runInterruptedPublication(); response.status(500).json({ error: 'process_was_not_interrupted' }) } catch (error) {
      trace7Armed = false;
      response.status(500).json({ error: error instanceof Error ? error.message : 'trace7_interruption_failed' });
    }
  });
  app.post('/proof-control/stop', (_request, response) => {
    response.json({ stopping: true });
    setTimeout(() => void stop(), 50);
  });
  app.use(filesApp);

  server = app.listen(port, '0.0.0.0');
  await new Promise((resolvePromise, reject) => { server.once('listening', resolvePromise); server.once('error', reject) });
  gateway = new SullaFilesSourceGateway();
  await gateway.start();
  gateway.unlock();
  const selected = await selectNativeSource();
  releaseNativeAccess = selected.release;
  sourceHandle = await gateway.registerExactFile(selected.sourcePath, selected.release);
  releaseNativeAccess = undefined;
  const initial = await gateway.read(sourceHandle);
  const localHeaders = { 'x-sulla-files-token': localToken };
  let ingestGate;
  const ingest = async({ operationId = randomUUID(), handle = sourceHandle, snapshot: source, fileId, baseVersionId, filesPath = 'Native Sources/round-trip.txt' }) => {
    if (ingestGate) {
      const gate = ingestGate;
      gate.entered.resolve();
      await gate.release.promise;
      if (ingestGate === gate) ingestGate = undefined;
    }
    const query = new URLSearchParams({ collectionId, path: filesPath });
    if (fileId) query.set('fileId', fileId);
    const response = await fetch(`http://127.0.0.1:${ port }/v1/local/native-sources/ingest?${ query }`, {
      method: 'PUT', headers: {
        ...localHeaders, 'content-type': 'text/plain', 'x-sulla-operation-id': operationId,
        'x-sulla-source-handle': handle, 'x-sulla-source-revision': source.revision,
        'x-sulla-source-hash': source.contentHash, ...(baseVersionId ? { 'x-sulla-files-base-version': baseVersionId } : {}),
      }, body: source.bytes,
    });
    if (!response.ok) throw new Error(`native ingest failed ${ response.status }: ${ await response.text() }`);
    return response.json();
  };
  if (trace7Mode !== 'recover') {
    await ingest({ snapshot: initial });
  } else {
    const [detached] = await manager.listNativeSources();
    if (!detached || detached.state !== 'reselect-required') throw new Error('Persisted native source did not require reselection');
    if (sourceHandle === detached.handle) throw new Error('Trace 7 reselection reused the revoked source handle');
    const rebound = await fetch(`http://127.0.0.1:${ port }/v1/local/native-sources/reselect-interrupted-publication`, {
      method: 'POST', headers: { ...localHeaders, 'content-type': 'application/json' }, body: JSON.stringify({
        fileId: detached.fileId, previousHandle: detached.handle, handle: sourceHandle,
        sourceRevision: initial.revision, sourceHash: initial.contentHash,
      }),
    });
    if (!rebound.ok) throw new Error(`Interrupted publication reselection failed ${ rebound.status }: ${ await rebound.text() }`);
    if (!(await rebound.json()).recovered) throw new Error('Persisted fixture had no interrupted publication to recover');
    lockedSourceHandle = detached.handle;
  }
  const createBroker = () => new SullaFilesNativeBroker({
    actions: () => manager.nativePublicationActions(),
    sources: () => manager.listNativeSources(),
    content: async(operationId) => {
      const response = await fetch(`http://127.0.0.1:${ port }/v1/local/native-sources/actions/${ operationId }/content`, { headers: localHeaders });
      return readBoundedResponse(response);
    },
    read:  handle => gateway.read(handle),
    write: (handle, revision, bytes) => gateway.write(handle, revision, bytes),
    ingest: input => ingest({
      operationId: input.operationId, handle: input.handle, snapshot: { bytes: input.bytes, revision: input.sourceRevision, contentHash: input.contentHash },
      fileId: input.fileId, baseVersionId: input.baseVersionId, filesPath: input.filesPath,
    }),
    finish: async(operationId, result) => {
      if (trace7Mode === 'prepare' && trace7Armed && result.nextSourceRevision) {
        trace7State = {
          schema: 1, fixtureKey: trace7Key, phase: 'published-not-acknowledged', databasePort,
          proofMaster: proofMaster.toString('base64'), signingKey: signingKey.toString('base64'), localToken,
          fuseContainer, nativeMacProof, operationId,
          evidence: {
            originalSourceRevision: result.originalSourceRevision, originalSourceHash: result.originalSourceHash,
            currentSourceRevision: result.nextSourceRevision, currentSourceHash: result.currentSourceHash,
            filesBaseVersionId: result.filesBaseVersionId, currentFilesVersionId: result.currentFilesVersionId,
          },
        };
        await writeTrace7State(trace7State);
        const evidence = { trace7: 'published-not-acknowledged', fixtureKey: trace7Key, operationId,
          ...trace7State.evidence, next: 'relaunch with SULLA_FILES_PROOF_TRACE7=recover and SULLA_FILES_PROOF_TRACE7_KEY set to fixtureKey' };
        await new Promise(resolvePromise => process.stdout.write(`${ JSON.stringify(evidence) }\n`, resolvePromise));
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => undefined);
      }
      const finished = await fetch(`http://127.0.0.1:${ port }/v1/local/native-sources/publications/${ operationId }/finish`, {
        method: 'POST', headers: { ...localHeaders, 'content-type': 'application/json' }, body: JSON.stringify(result),
      });
      if (!finished.ok) throw new Error(`native finish failed ${ finished.status }: ${ await finished.text() }`);
    },
    logError: (message, error) => console.error('[synthetic-broker]', message, error instanceof Error ? error.message : String(error)),
  });
  broker = createBroker();
  broker.resume();
  brokerTimer = setInterval(() => broker.poll().catch(error => console.error('[synthetic-broker]', error.message)), 25);
  runInterruptedPublication = trace7Mode === 'prepare' ? async() => {
    trace7Armed = true;
    await ordinaryFuseEdit(`trace 7 interrupted publication ${ new Date().toISOString() }\n`);
  } : undefined;
  if (trace7Mode === 'recover') {
    clearInterval(brokerTimer);
    brokerTimer = undefined;
    const [action] = await manager.nativePublicationActions();
    const expected = trace7State.evidence;
    const exactPending = action?.state === 'recovery-required' && action.operationId === trace7State.operationId &&
      action.sourceRevision === expected.originalSourceRevision && action.sourceHash === expected.originalSourceHash &&
      action.desiredHash === expected.currentSourceHash && action.baseVersionId === expected.filesBaseVersionId &&
      action.versionId === expected.currentFilesVersionId;
    if (!exactPending) throw new Error('Persisted publication action did not retain the exact source and Files identities');
    await broker.poll();
    await waitFor(async() => !(await manager.nativePublicationActions()).length, 'Interrupted publication acknowledgement did not reach a durable terminal state');
    const remaining = await manager.nativePublicationActions();
    const [recovered] = await manager.listNativeSources();
    const current = await gateway.read(sourceHandle);
    const oldHandleRevoked = await gateway.read(lockedSourceHandle).then(() => false, () => true);
    const exactRecovered = !remaining.length && recovered?.state === 'active' && recovered.versionId === expected.currentFilesVersionId &&
      recovered.sourceRevision === expected.currentSourceRevision && recovered.sourceHash === expected.currentSourceHash &&
      current.revision === expected.currentSourceRevision && current.contentHash === expected.currentSourceHash;
    if (!exactRecovered || !oldHandleRevoked) throw new Error('Interrupted publication recovery did not preserve exact source and Files outcomes');
    console.log(JSON.stringify({
      trace7: 'recovered-and-cleaning', fixtureKey: trace7Key, operationId: action.operationId,
      oldHandleRevoked, newHandleActive: true, originalSourceRevision: action.sourceRevision,
      originalSourceHash: action.sourceHash, currentSourceRevision: current.revision, currentSourceHash: current.contentHash,
      filesBaseVersionId: action.baseVersionId, currentFilesVersionId: recovered.versionId,
    }));
    await stop(0);
  }
  runLockDrain = async() => {
    if (lockedSourceHandle) throw new Error('Synthetic source session is already locked');
    const [source] = await manager.listNativeSources();
    const entered = deferred(); const release = deferred();
    ingestGate = { entered, release };
    await writeFile(proofPath, `lock drain source edit ${ new Date().toISOString() }\n`);
    const poll = broker.poll();
    await entered.promise;
    let drained = false;
    const oldHandle = sourceHandle;
    const lock = broker.suspendAndDrain(() => gateway.lock()).then(() => { drained = true });
    await Promise.resolve();
    const waitedForInflight = !drained;
    release.resolve();
    await Promise.all([poll, lock]);
    const locked = await fetch(`http://127.0.0.1:${ port }/v1/local/lock`, { method: 'POST', headers: localHeaders });
    if (!locked.ok) throw new Error(`Files lock failed (${ locked.status })`);
    const oldHandleRevoked = await gateway.read(oldHandle).then(() => false, () => true);
    lockedSourceHandle = oldHandle;
    return { waitedForInflight, oldHandleRevoked, sourceState: (await manager.listNativeSources())[0]?.state, priorVersionId: source.versionId };
  };
  runSessionRecovery = async() => {
    if (!lockedSourceHandle) throw new Error('Run lock + drain before session recovery');
    await keyring.unlock(Buffer.from(proofMaster), signingKey);
    await manager.initialize();
    await manager.revalidateNativeSessions([]);
    const [detached] = await manager.listNativeSources();
    if (detached?.state !== 'reselect-required') throw new Error('Locked source did not require reselection');
    gateway.unlock();
    const reselected = await selectNativeSource();
    releaseNativeAccess = reselected.release;
    const nextHandle = await gateway.registerExactFile(reselected.sourcePath, reselected.release);
    releaseNativeAccess = undefined;
    const current = await gateway.read(nextHandle);
    const result = await ingest({ handle: nextHandle, snapshot: current, fileId: detached.fileId, baseVersionId: detached.versionId, filesPath: detached.path });
    const oldHandleRevoked = await gateway.read(lockedSourceHandle).then(() => false, () => true);
    sourceHandle = nextHandle;
    lockedSourceHandle = undefined;
    broker.resume();
    return { reselectRequired: true, oldHandleRevoked, newHandleActive: true, fileId: result.id, versionId: result.current_version_id };
  };
  runConcurrentConflict = async() => {
    const program = 'import base64,os,sys;p=sys.argv[1];b=base64.b64decode(sys.argv[2]);f=open(p,"r+b");f.truncate(0);f.write(b);f.flush();print("READY",flush=True);sys.stdin.readline();errno=0\ntry: os.fsync(f.fileno())\nexcept OSError as e: errno=e.errno\ntry: f.close()\nexcept OSError as e: errno=errno or e.errno\nprint("ERRNO="+str(errno),flush=True)';
    const staleBytes = Buffer.from(`stale FUSE edit ${ new Date().toISOString() }\n`).toString('base64');
    const command = nativeMacProof
      ? ['docker', ['exec', '--interactive', fuseContainer, 'python3', '-c', program, containerMountedPath, staleBytes]]
      : ['python3', ['-c', program, mountedPath, staleBytes]];
    const child = spawn(command[0], command[1], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString() });
    child.stderr.on('data', chunk => { stderr += chunk.toString() });
    try {
      await waitFor(() => stdout.includes('READY'), `Stale FUSE writer did not become ready: ${ stderr }`);
      await writeFile(proofPath, `concurrent external edit ${ new Date().toISOString() }\n`);
      child.stdin.end('\n');
      await new Promise((resolvePromise, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`Stale FUSE writer exited ${ code }: ${ stderr }`)));
      });
      const flushErrno = Number(stdout.match(/ERRNO=(\d+)/)?.[1] ?? 0);
      if (flushErrno !== 5) throw new Error(`Concurrent stale flush returned errno ${ flushErrno }, expected EIO (5)`);
      await waitFor(async() => (await manager.fuseSnapshot(collectionId)).some(file => file.path.includes('conflicted copy Files')), 'Visible Files conflict was not created');
      return { flushErrno, expectedErrno: 5, ...(await snapshot(collectionId)) };
    } catch (error) { child.kill('SIGTERM'); throw error }
  };
  if (nativeMacProof) {
    const image = process.env.SULLA_FILES_PROOF_FUSE_IMAGE ?? 'sulla-files-fuse-proof:local';
    fuse = spawn('docker', [
      'run', '--rm', '--name', fuseContainer, '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
      '--cap-add', 'SYS_ADMIN', '--device', '/dev/fuse', '--security-opt', 'apparmor=unconfined',
      '-e', 'SULLA_FILES_FUSE_TOKEN_FILE=/run/secrets/sulla-files-token',
      '-v', `${ fuseTokenPath }:/run/secrets/sulla-files-token:ro`, '-v', `${ here }:/proof:ro`, image,
      'python3', '/proof/sulla_files_fuse.py', '--url', `http://host.docker.internal:${ port }`, '--collection', collectionId, '/mnt/proof',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } else {
    fuse = spawn('python3', [resolve(here, 'sulla_files_fuse.py'), '--url', `http://127.0.0.1:${ port }`, '--collection', collectionId, mountRoot], {
      env: { ...process.env, SULLA_FILES_FUSE_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  let fuseError = '';
  fuse.stderr.on('data', chunk => { fuseError += chunk.toString() });
  await waitFor(async() => nativeMacProof
    ? run('docker', ['exec', fuseContainer, 'mountpoint', '-q', '/mnt/proof']).then(() => true, () => false)
    : run('mountpoint', ['-q', mountRoot]).then(() => true, () => false), `FUSE mount did not become ready: ${ fuseError }`);
  console.log(JSON.stringify({
    ready: true,
    url: `http://127.0.0.1:${ port }/proof-control/`,
    ...(nativeMacProof ? {} : { vmUrl: `http://${ reachableAddress() }:${ port }/proof-control/` }),
    fixture: basename(root),
    ...(trace7Mode ? { trace7Mode, fixtureKey: trace7Key } : {}),
    sourceHandle: `${ sourceHandle.slice(0, 6) }…`,
    isolation: nativeMacProof ? 'native macOS gateway + disposable Docker FUSE + temporary PostgreSQL' : 'temporary Linux gateway/FUSE/PostgreSQL',
    controls: ['fuse-edit', 'external-edit', 'concurrent-conflict', 'lock-drain', 'session-recovery', ...(trace7Mode === 'prepare' ? ['trace7-interrupt'] : []), 'reset', 'status', 'stop'],
  }));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  await stop(1);
}
