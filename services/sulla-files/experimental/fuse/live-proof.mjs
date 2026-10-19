#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
import { SullaFilesSourceGateway } from '../../../../pkg/rancher-desktop/main/sullaFilesSourceGateway.ts';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const port = Number(process.env.SULLA_FILES_PROOF_PORT ?? 48792);
const root = await mkdtemp(join(tmpdir(), 'sulla-files-live-proof-'));
const cluster = join(root, 'postgres');
const sourceRoot = join(root, 'synthetic-source');
const mountRoot = join(root, 'mount');
const proofPath = join(sourceRoot, 'Proof', 'round-trip.txt');
const mountedPath = join(mountRoot, 'Native Sources', 'round-trip.txt');
const containerMountedPath = '/mnt/proof/Native Sources/round-trip.txt';
const fuseContainer = `sulla-files-native-proof-${ process.pid }`;
const databasePort = 50_000 + (process.pid % 10_000);
const originalBytes = 'original synthetic bytes\n';

let admin;
let db;
let fuse;
let keyring;
let manager;
let gateway;
let brokerTimer;
let server;
let stopping = false;
let releaseNativeAccess;

const nativeMacProof = process.env.SULLA_FILES_MACOS_NATIVE_PROOF === '1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

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
  const electron = await import('electron');
  if (!electron.app?.whenReady || !electron.dialog?.showOpenDialog) throw new Error('Run the native proof with Electron, not plain Node');
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
  if (nativeMacProof) await run('docker', ['stop', '--time', '5', fuseContainer]).catch(() => undefined);
  else {
    await run('fusermount3', ['-u', mountRoot]).catch(() => undefined);
    if (fuse?.exitCode === null) fuse.kill('SIGTERM');
  }
  await manager?.close().catch(() => undefined);
  if (brokerTimer) clearInterval(brokerTimer);
  await gateway?.stop().catch(() => undefined);
  await new Promise(resolvePromise => server ? server.close(resolvePromise) : resolvePromise());
  keyring?.close();
  await db?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await run('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']).catch(() => undefined);
  releaseNativeAccess?.();
  await rm(root, { recursive: true, force: true });
  process.exit(exitCode);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());

try {
  await Promise.all([mkdir(join(sourceRoot, 'Proof'), { recursive: true }), mkdir(mountRoot, { recursive: true })]);
  await writeFile(proofPath, originalBytes);
  await run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres', '--no-locale']);
  await run('pg_ctl', ['-D', cluster, '-w', 'start', '-o', `-F -p ${ databasePort } -h 127.0.0.1 -k ${ root }`, '-l', join(root, 'postgres.log')]);

  admin = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ databasePort }/postgres` });
  await admin.query('CREATE DATABASE files_fuse_live_proof');
  const databaseUrl = `postgresql://postgres@127.0.0.1:${ databasePort }/files_fuse_live_proof`;
  db = new pg.Pool({ connectionString: databaseUrl });
  await migrate(db);
  const master = randomBytes(32);
  const signingKey = randomBytes(32);
  keyring = new FilesKeyring(db);
  await keyring.unlock(master, signingKey);
  master.fill(0);
  const localToken = randomBytes(32).toString('base64url');
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
  const collectionId = await manager.nativeCollectionId();
  const token = issueProofToken({ sub: config.userId, device_id: config.deviceId, scopes: ['files/*'] }, signingKey);
  const fuseTokenPath = join(root, 'fuse-token');
  await writeFile(fuseTokenPath, token, { mode: 0o600 });
  const filesApp = createApp(db, config, manager);
  const app = express();
  let runConcurrentConflict;

  app.get('/proof-control/', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Synthetic Files FUSE proof</title><style>body{margin:0;background:#111;color:#ddd;font:14px system-ui}header{display:flex;gap:12px;align-items:center;padding:10px 14px;border-bottom:1px solid #444;flex-wrap:wrap}button{padding:7px 10px}#result{white-space:pre-wrap;color:#9dd;padding-left:8px}iframe{width:100%;height:calc(100vh - 96px);border:0}</style></head><body><header><strong>Synthetic Files + FUSE proof</strong><button id="edit">Ordinary FUSE edit</button><button id="external">External source edit</button><button id="conflict">Concurrent conflict</button><button id="reset">Reset source</button><button id="status">Status</button><span id="result">Ready</span></header><iframe id="files"></iframe><script type="module">const frame=document.querySelector('#files');const result=document.querySelector('#result');const session=()=>frame.contentWindow.postMessage({type:'sulla:files-session',token:${ JSON.stringify(token) },orgId:'synthetic-proof',email:'Synthetic proof'},location.origin);const call=async path=>{result.textContent='Running…';const response=await fetch('/proof-control/'+path,{method:'POST'});result.textContent=JSON.stringify(await response.json(),null,2)};document.querySelector('#edit').onclick=()=>call('fuse-edit');document.querySelector('#external').onclick=()=>call('external-edit');document.querySelector('#conflict').onclick=()=>call('concurrent-conflict');document.querySelector('#reset').onclick=()=>call('reset');document.querySelector('#status').onclick=()=>call('status');addEventListener('message',event=>{if(event.origin===location.origin&&event.source===frame.contentWindow&&event.data?.type==='sulla:files-ready')session()});frame.addEventListener('load',session,{once:true});frame.src='/files-proof/';</script></body></html>`);
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
  app.use(filesApp);

  server = app.listen(port, '0.0.0.0');
  await new Promise((resolvePromise, reject) => { server.once('listening', resolvePromise); server.once('error', reject) });
  gateway = new SullaFilesSourceGateway();
  await gateway.start();
  gateway.unlock();
  const selected = await selectNativeSource();
  releaseNativeAccess = selected.release;
  const sourceHandle = await gateway.registerExactFile(selected.sourcePath, selected.release);
  releaseNativeAccess = undefined;
  const initial = await gateway.read(sourceHandle);
  const localHeaders = { 'x-sulla-files-token': localToken };
  const ingest = async({ operationId = randomUUID(), handle = sourceHandle, snapshot: source, fileId, baseVersionId, filesPath = 'Native Sources/round-trip.txt' }) => {
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
  await ingest({ snapshot: initial });
  let brokerBusy = false;
  const brokerCycle = async() => {
    if (brokerBusy) return;
    brokerBusy = true;
    try {
      const actionResponse = await fetch(`http://127.0.0.1:${ port }/v1/local/native-sources/actions`, { headers: localHeaders });
      const actions = await actionResponse.json();
      for (const action of actions) {
        try {
          const content = await fetch(`http://127.0.0.1:${ port }/v1/local/native-sources/actions/${ action.operationId }/content`, { headers: localHeaders });
          const bytes = Buffer.from(await content.arrayBuffer());
          const before = await gateway.read(action.handle);
          const result = before.contentHash === action.desiredHash ? before : await gateway.write(action.handle, action.sourceRevision, bytes);
          const finished = await fetch(`http://127.0.0.1:${ port }/v1/local/native-sources/publications/${ action.operationId }/finish`, {
            method: 'POST', headers: { ...localHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ nextSourceRevision: result.revision }),
          });
          if (!finished.ok) throw new Error(`native finish failed ${ finished.status }: ${ await finished.text() }`);
        } catch (error) {
          if (!error?.conflictHandle) throw error;
          const source = (await manager.listNativeSources()).find(item => item.handle === action.handle);
          const conflict = await gateway.read(error.conflictHandle);
          const conflictFile = await ingest({ handle: error.conflictHandle, snapshot: conflict, filesPath: 'Native Sources/round-trip (conflicted copy Files).txt' });
          const external = await gateway.read(source.handle);
          const currentFile = await ingest({ snapshot: external, fileId: source.fileId, baseVersionId: source.versionId, filesPath: source.path });
          await fetch(`http://127.0.0.1:${ port }/v1/local/native-sources/publications/${ action.operationId }/finish`, {
            method: 'POST', headers: { ...localHeaders, 'content-type': 'application/json' }, body: JSON.stringify({
              conflictFileId: conflictFile.id, currentSourceRevision: external.revision, currentSourceHash: external.contentHash,
              currentFilesVersionId: currentFile.current_version_id,
            }),
          });
        }
      }
      if (!actions.length) {
        const [source] = await manager.listNativeSources();
        if (source?.state === 'active') {
          const current = await gateway.read(source.handle);
          if (current.revision !== source.sourceRevision) await ingest({ snapshot: current, fileId: source.fileId, baseVersionId: source.versionId, filesPath: source.path });
        }
      }
    } finally { brokerBusy = false }
  };
  brokerTimer = setInterval(() => brokerCycle().catch(error => console.error('[synthetic-broker]', error.message)), 25);
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
    sourceHandle: `${ sourceHandle.slice(0, 6) }…`,
    isolation: nativeMacProof ? 'native macOS gateway + disposable Docker FUSE + temporary PostgreSQL' : 'temporary Linux gateway/FUSE/PostgreSQL',
    controls: ['fuse-edit', 'external-edit', 'concurrent-conflict', 'reset', 'status'],
  }));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  await stop(1);
}
