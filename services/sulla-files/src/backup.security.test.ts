import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  generateX25519RecipientKeyPair,
  rewrapFilesKeyBundleForDevice,
  type Base64,
  type FilesKeyBundleContext,
  type FilesKeyBundleEnvelope,
} from '@sulla/vault-crypto';
import pg from 'pg';

import { sha256File, validateAndExtractContainer } from './backup/container.js';
import { backup, restore } from './backup.js';
import { chunkId, decryptChunk, encryptChunk } from './crypto.js';
import { migrate } from './db.js';
import { FilesKeyBundleRecovery, type FilesKeyBundleAuthority, type StoredFilesKeyBundle } from './keyBundleRecovery.js';
import { FilesKeyring } from './keyring.js';
import { Store } from './store.js';

import type { Config } from './config.js';

const run = promisify(execFile);

class SyntheticAuthority implements FilesKeyBundleAuthority {
  readonly pair = generateX25519RecipientKeyPair();
  readonly bundles = new Map<string, StoredFilesKeyBundle>();
  private id(context:FilesKeyBundleContext):string { return `${ context.principalId }:${ context.collectionId }:${ context.keyVersion }:${ context.epoch }` }
  async custodyRecipient(_context:FilesKeyBundleContext):Promise<{ keyId: string; publicKey: Base64 }> {
    return { keyId: 'synthetic-authority', publicKey: (await this.pair).publicKey };
  }

  async registerBundle(bundle:StoredFilesKeyBundle):Promise<void> { await Promise.resolve(); this.bundles.set(this.id(bundle.context), bundle) }
  async authorizeDeviceRecovery(request:{ context: FilesKeyBundleContext; devicePublicKey: Base64 }):Promise<FilesKeyBundleEnvelope> {
    const bundle = this.bundles.get(this.id(request.context));
    if (!bundle) throw new Error('Synthetic custody bundle is unavailable');
    const pair = await this.pair;
    return rewrapFilesKeyBundleForDevice(bundle.envelope, request.context, pair.publicKey, pair.privateKey, request.devicePublicKey);
  }
}

function config(databaseUrl:string, root:string, backupTarget:string):Config {
  return {
    port:                 0,
    databaseUrl,
    chunkRoot:            join(root, 'chunks'),
    dataRoot:             root,
    backupTarget,
    capabilitySigningKey: randomBytes(32),
    mode:                 'desktop',
    deviceId:             'synthetic-device',
    userId:               'synthetic-principal',
    cloudUrl:             'https://invalid.test',
    paused:               true,
    modelDir:             join(root, 'models'),
  };
}

test('coherent backup restores synthetic PostgreSQL/chunks, rejects tampering, and supports fresh-device custody recovery', async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-backup-security-'));
  const cluster = join(root, 'postgres');
  const port = 54_000 + (process.pid % 1_000);
  await run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres', '--no-locale']);
  await run('pg_ctl', ['-D', cluster, '-w', 'start', '-o', `-F -p ${ port } -h 127.0.0.1 -k ${ root }`, '-l', join(root, 'postgres.log')]);
  const admin = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ port }/postgres` });
  let source:pg.Pool | undefined;
  let target:pg.Pool | undefined;
  try {
    await admin.query('CREATE DATABASE files_source'); await admin.query('CREATE DATABASE files_target');
    const sourceUrl = `postgresql://postgres@127.0.0.1:${ port }/files_source`;
    const targetUrl = `postgresql://postgres@127.0.0.1:${ port }/files_target`;
    source = new pg.Pool({ connectionString: sourceUrl }); target = new pg.Pool({ connectionString: targetUrl });
    await migrate(source); await migrate(target);
    const collectionId = '11111111-1111-4111-8111-111111111111';
    const fileId = '22222222-2222-4222-8222-222222222222';
    const versionId = '33333333-3333-4333-8333-333333333333';
    const oldMaster = randomBytes(32);
    const sourceKeyring = new FilesKeyring(source); await sourceKeyring.unlock(oldMaster, randomBytes(32));
    await source.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state)
      VALUES($1,'synthetic-principal','Synthetic','knowledge','desktop-only','{}','{}','native')`, [collectionId]);
    const client = await source.connect();
    try { await client.query('BEGIN'); await sourceKeyring.create(collectionId, client); await client.query('COMMIT') } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    const authority = new SyntheticAuthority();
    await new FilesKeyBundleRecovery(source, sourceKeyring, authority).enrollCollection(collectionId);

    const plaintext = Buffer.from('synthetic ciphertext round trip; no live Files or Vault data');
    const keys = await sourceKeyring.keys(collectionId); const id = chunkId(plaintext, keys.dedup);
    const ciphertext = await encryptChunk(plaintext, keys.data, id);
    const sourceConfig = config(sourceUrl, join(root, 'source-data'), join(root, 'backups'));
    await new Store(sourceConfig.chunkRoot).put(collectionId, id, ciphertext);
    const manifestHash = createHash('sha256').update(JSON.stringify({ ids: [id], size: plaintext.length })).digest('hex');
    await source.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3)', [manifestHash, JSON.stringify([id]), plaintext.length]);
    await source.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount)
      VALUES($1,$2,$3,$4,$5,1)`, [collectionId, id, plaintext.length, ciphertext.length, `chunks/${ collectionId }/${ id }`]);
    await source.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size)
      VALUES($1,$2,'proof.bin','user','synthetic-principal','application/octet-stream',$3)`, [fileId, collectionId, plaintext.length]);
    await source.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,$4,$5,'user','synthetic-principal','synthetic-device')`, [versionId, fileId, collectionId, manifestHash, plaintext.length]);
    await source.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    await source.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user','synthetic-principal','manage')", [collectionId]);
    await source.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [collectionId, fileId, versionId]);
    await source.query("INSERT INTO audit_log(who_type,who_id,file_id,version_id,action) VALUES('user','synthetic-principal',$1,$2,'upload')", [fileId, versionId]);
    const archive = await backup(sourceConfig); sourceKeyring.close(); oldMaster.fill(0);

    const targetConfig = config(targetUrl, join(root, 'target-data'), join(root, 'backups'));
    const original = await readFile(archive);
    const escape = Buffer.from(original); const safe = Buffer.from('database/rows.jsonl'); const unsafe = Buffer.from('../abase/rows.jsonl');
    const pathOffset = escape.indexOf(safe); assert.notEqual(pathOffset, -1); unsafe.copy(escape, pathOffset);
    const escapeArchive = join(root, 'escape.sulla-files-backup'); await writeFile(escapeArchive, escape);
    await assert.rejects(restore(targetConfig, escapeArchive), /Unsafe backup entry path/);
    const tampered = Buffer.from(original); tampered[tampered.length - 1] ^= 1;
    const tamperedArchive = join(root, 'tampered.sulla-files-backup'); await writeFile(tamperedArchive, tampered);
    await assert.rejects(restore(targetConfig, tamperedArchive), /digest mismatch/);
    assert.equal((await target.query('SELECT count(*)::int AS count FROM collections')).rows[0].count, 0);

    // A crash before durable state/stage creation must never cause prefix-scan
    // cleanup to infer ownership of an existing target.
    await mkdir(targetConfig.chunkRoot, { recursive: true });
    const sentinel = join(targetConfig.chunkRoot, 'preexisting'); await writeFile(sentinel, 'preserve me');
    const unstated = await mkdtemp(join(dirname(targetConfig.chunkRoot), '.sulla-files-restore-'));
    await assert.rejects(restore(targetConfig, archive), /no durable publication state/);
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve me');
    await rm(unstated, { recursive: true }); await rm(targetConfig.chunkRoot, { recursive: true });

    // Model a process death after ciphertext rename but before PostgreSQL COMMIT.
    // The next invocation must prove there is no durable marker, roll the
    // ciphertext publication back, and safely resume from the archive.
    const inspection = await validateAndExtractContainer(archive, join(root, 'archive-inspection'));
    const snapshotId = inspection.manifest.snapshotId; await inspection.cleanup();
    const archiveSha256 = (await sha256File(archive)).sha256;
    await new Store(targetConfig.chunkRoot).put(collectionId, id, ciphertext);
    const published = await stat(targetConfig.chunkRoot);
    const interrupted = await mkdtemp(join(dirname(targetConfig.chunkRoot), '.sulla-files-restore-'));
    await mkdir(join(interrupted, 'validated'), { recursive: true });
    await writeFile(join(interrupted, 'publication.json'), JSON.stringify({
      version:          1,
      phase:            'chunks-published',
      snapshotId,
      archiveSha256,
      publicationToken: randomUUID(),
      stagedIdentity:   { device: String(published.dev), inode: String(published.ino) },
      targetBefore:     null,
    }));

    await restore(targetConfig, archive);
    assert.equal((await target.query('SELECT archive_sha256 FROM files_restore_publications WHERE snapshot_id=$1', [snapshotId])).rows[0].archive_sha256, archiveSha256);
    assert.deepEqual((await readdir(dirname(targetConfig.chunkRoot))).filter(name => name.startsWith('.sulla-files-restore-')), []);
    assert.equal((await target.query('SELECT refcount::int FROM chunks WHERE collection_id=$1 AND id=$2', [collectionId, id])).rows[0].refcount, 1);
    assert.equal((await target.query('SELECT count(*)::int AS count FROM collection_acl')).rows[0].count, 1);
    assert.equal((await target.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count, 1);
    const replacementMaster = randomBytes(32); const targetKeyring = new FilesKeyring(target);
    assert.equal(await new FilesKeyBundleRecovery(target, targetKeyring, authority).recoverDeviceMaster(replacementMaster, 'synthetic-principal'), 1);
    const recoveredKeys = await targetKeyring.keys(collectionId);
    const recovered = await decryptChunk(await new Store(targetConfig.chunkRoot).get(collectionId, id), recoveredKeys.data, id);
    assert.deepEqual(recovered, plaintext);
    targetKeyring.close(); replacementMaster.fill(0);
  } finally {
    await Promise.all([source?.end(), target?.end()]); await admin.end();
    await run('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop']).catch(() => undefined); await rm(root, { recursive: true, force: true });
  }
});
