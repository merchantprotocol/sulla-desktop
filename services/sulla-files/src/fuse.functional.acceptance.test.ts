import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import { createApp } from './app.js';
import { issueCapabilityToken } from './auth.js';
import { migrate } from './db.js';
import { FilesKeyring } from './keyring.js';
import { LocalFilesManager } from './localManager.js';

import type { Config } from './config.js';

const run = promisify(execFile);
const sleep = (milliseconds:number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(predicate:()=>Promise<boolean>, message:string, attempts = 200):Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(message);
}

async function waitForChild(child:ChildProcess, label:string):Promise<void> {
  if (child.exitCode !== null) {
    if (child.exitCode !== 0) throw new Error(`${ label } exited ${ child.exitCode }`);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${ label } exited ${ code }`)));
    child.once('error', reject);
  });
}

test('real FUSE mount writes through Files and fails closed on conflict and outage', { timeout: 120_000 }, async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-fuse-acceptance-'));
  const cluster = join(root, 'postgres');
  const sourceRoot = join(root, 'synthetic-source');
  const mountRoot = join(root, 'mount');
  const proofPath = join(sourceRoot, 'Proof', 'round-trip.txt');
  const port = 48_000 + (process.pid % 8_000);
  await Promise.all([mkdir(join(sourceRoot, 'Proof'), { recursive: true }), mkdir(mountRoot, { recursive: true })]);
  await writeFile(proofPath, 'original synthetic bytes\n');
  await run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres', '--no-locale']);
  await run('pg_ctl', ['-D', cluster, '-w', 'start', '-o', `-F -p ${ port } -h 127.0.0.1 -k ${ root }`, '-l', join(root, 'postgres.log')]);

  const admin = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ port }/postgres` });
  let db:pg.Pool | undefined;
  let server:ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
  let manager:LocalFilesManager | undefined;
  let fuse:ChildProcess | undefined;
  const master = randomBytes(32);
  let keyring:FilesKeyring | undefined;
  try {
    await admin.query('CREATE DATABASE files_fuse_acceptance');
    const databaseUrl = `postgresql://postgres@127.0.0.1:${ port }/files_fuse_acceptance`;
    db = new pg.Pool({ connectionString: databaseUrl });
    await migrate(db);
    const signingKey = randomBytes(32);
    keyring = new FilesKeyring(db);
    await keyring.unlock(master, signingKey);
    const config:Config = {
      keyring,
      port: 0,
      databaseUrl,
      chunkRoot: join(root, 'chunks'),
      dataRoot: join(root, 'data'),
      filesRoot: sourceRoot,
      caseInsensitiveRoot: false,
      capabilitySigningKey: signingKey,
      mode: 'desktop',
      deviceId: 'synthetic-fuse-device',
      userId: 'synthetic-fuse-owner',
      cloudUrl: 'https://invalid.test',
      paused: false,
      modelDir: join(root, 'unused-model'),
      fileRoots: [{ id: 'default', name: 'Synthetic tracked collection', path: sourceRoot, syncMode: 'local', paused: false, exclusions: [], primary: true }],
      fuseExperiment: true,
    };
    manager = new LocalFilesManager(db, config);
    await manager.initialize();
    const collectionId = (await manager.listRoots())[0].collectionId;
    server = createApp(db, config, manager).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) });
    const address = server.address();
    assert(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${ address.port }`;
    const token = issueCapabilityToken({ sub: config.userId, device_id: config.deviceId, scopes: ['files/*'] }, signingKey);
    const auth = { authorization: `Bearer ${ token }` };
    const adapter = join(process.cwd(), 'experimental/fuse/sulla_files_fuse.py');
    fuse = spawn('python3', [adapter, '--url', baseUrl, '--collection', collectionId, mountRoot], {
      env: { ...process.env, SULLA_FILES_FUSE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let fuseError = '';
    fuse.stderr?.on('data', chunk => { fuseError += chunk.toString() });
    await waitFor(async() => run('mountpoint', ['-q', mountRoot]).then(() => true, () => false), `FUSE mount did not become ready: ${ fuseError }`);

    const mountedFile = join(mountRoot, 'Proof', 'round-trip.txt');
    const ordinaryEdit = Buffer.from('agent wrote through a real FUSE fd\n');
    await run('python3', ['-c', `import os,sys\np=sys.argv[1]\nf=open(p,'r+b',buffering=0)\nf.seek(0); f.truncate(); f.write(${ JSON.stringify(ordinaryEdit.toString()) }.encode()); f.flush(); os.fsync(f.fileno()); f.close()`, mountedFile]);
    assert.deepEqual(await readFile(proofPath), ordinaryEdit);

    let filesResponse = await fetch(`${ baseUrl }/v1/files?collectionId=${ collectionId }`, { headers: auth });
    assert.equal(filesResponse.status, 200);
    let files = await filesResponse.json() as any[];
    const originalFile = files.find(file => file.path === 'Proof/round-trip.txt');
    assert(originalFile);
    assert.equal(Number(originalFile.size), ordinaryEdit.length);
    const downloaded = await fetch(`${ baseUrl }/v1/files/${ originalFile.id }/download`, { headers: auth });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), ordinaryEdit);

    const externalBytes = Buffer.from('external writer refresh\n');
    await writeFile(proofPath, externalBytes);
    assert.deepEqual(Buffer.from((await run('cat', [mountedFile])).stdout), externalBytes);
    filesResponse = await fetch(`${ baseUrl }/v1/files?collectionId=${ collectionId }`, { headers: auth });
    files = await filesResponse.json() as any[];
    assert.equal(Number(files.find(file => file.id === originalFile.id).size), externalBytes.length);

    const ready = join(root, 'conflict-ready');
    const gate = join(root, 'conflict-go');
    const result = join(root, 'conflict-result');
    const conflictBytes = 'agent conflict bytes\n';
    const conflictWriter = spawn('python3', ['-c', `import errno,os,sys,time\np,ready,gate,result=sys.argv[1:]\nf=open(p,'r+b',buffering=0)\nopen(ready,'w').close()\nwhile not os.path.exists(gate): time.sleep(.01)\nf.seek(0); f.truncate(); f.write(${ JSON.stringify(conflictBytes) }.encode()); f.flush()\ntry: os.fsync(f.fileno()); open(result,'w').write('unexpected-success')\nexcept OSError as e: open(result,'w').write(str(e.errno))\ntry: f.close()\nexcept OSError: pass`, mountedFile, ready, gate, result]);
    await waitFor(async() => readFile(ready).then(() => true, () => false), 'conflict writer did not open the FUSE file');
    const concurrentBytes = Buffer.from('newer external bytes survive\n');
    await writeFile(proofPath, concurrentBytes);
    await writeFile(gate, 'go');
    await waitForChild(conflictWriter, 'conflict writer');
    assert.equal((await readFile(result, 'utf8')).trim(), '5');
    assert.deepEqual(await readFile(proofPath), concurrentBytes);
    filesResponse = await fetch(`${ baseUrl }/v1/fuse/files?collectionId=${ collectionId }`, { headers: auth });
    files = await filesResponse.json() as any[];
    const conflict = files.find(file => /conflicted copy synthetic-fuse-device-/.test(file.path));
    assert(conflict, 'conflicting agent bytes must remain visible in Files');
    const conflictDownload = await fetch(`${ baseUrl }/v1/files/${ conflict.id }/download`, { headers: auth });
    assert.deepEqual(Buffer.from(await conflictDownload.arrayBuffer()), Buffer.from(conflictBytes));

    const outageReady = join(root, 'outage-ready');
    const outageGate = join(root, 'outage-go');
    const outageResult = join(root, 'outage-result');
    const outageWriter = spawn('python3', ['-c', `import os,sys,time\np,ready,gate,result=sys.argv[1:]\nf=open(p,'r+b',buffering=0)\nopen(ready,'w').close()\nwhile not os.path.exists(gate): time.sleep(.01)\nf.seek(0); f.truncate(); f.write(b'outage bytes must not be acknowledged\\n'); f.flush()\ntry: os.fsync(f.fileno()); open(result,'w').write('unexpected-success')\nexcept OSError as e: open(result,'w').write(str(e.errno))\nos._exit(0)`, mountedFile, outageReady, outageGate, outageResult]);
    await waitFor(async() => readFile(outageReady).then(() => true, () => false), 'outage writer did not open the FUSE file');
    const stoppingServer = server;
    const stopped = new Promise<void>(resolve => stoppingServer.close(() => resolve()));
    stoppingServer.closeAllConnections();
    await stopped;
    server = undefined;
    await writeFile(outageGate, 'go');
    await waitForChild(outageWriter, 'outage writer');
    assert.equal((await readFile(outageResult, 'utf8')).trim(), '5');
    assert.deepEqual(await readFile(proofPath), concurrentBytes);
  } finally {
    await run('fusermount3', ['-u', mountRoot]).catch(() => undefined);
    if (fuse && fuse.exitCode === null) fuse.kill('SIGTERM');
    if (fuse) await Promise.race([waitForChild(fuse, 'FUSE adapter').catch(() => undefined), sleep(2_000)]);
    if (fuse && fuse.exitCode === null) fuse.kill('SIGKILL');
    await manager?.close().catch(() => undefined);
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
    keyring?.close(); master.fill(0);
    await db?.end(); await admin.end();
    await run('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
