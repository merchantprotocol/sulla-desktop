import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import pg from 'pg';

import { migrate } from './db.js';
import { LocalFilesManager, type NativePublicationCompletionProof } from './localManager.js';

import type { Config } from './config.js';

const run = promisify(execFile);
const revision = (character:string) => character.repeat(64);
const handle = (character:string) => character.repeat(43);

test('native publication completion serializes source/version identity and preserves exact crash recovery binding', { timeout: 30_000 }, async() => {
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-native-publication-integrity-'));
  const cluster = join(root, 'postgres');
  const port = 46_000 + (process.pid % 10_000);
  await run('initdb', ['-D', cluster, '-A', 'trust', '-U', 'postgres', '--no-locale']);
  await run('pg_ctl', ['-D', cluster, '-w', 'start', '-o', `-F -p ${ port } -h 127.0.0.1 -k ${ root }`, '-l', join(root, 'postgres.log')]);

  const admin = new pg.Pool({ connectionString: `postgresql://postgres@127.0.0.1:${ port }/postgres` });
  let db:pg.Pool | undefined;
  try {
    await admin.query('CREATE DATABASE files_native_publication_integrity');
    const databaseUrl = `postgresql://postgres@127.0.0.1:${ port }/files_native_publication_integrity`;
    db = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    await migrate(db);
    const config:Config = {
      databaseUrl,
      port:                 0,
      chunkRoot:            join(root, 'chunks'),
      dataRoot:             join(root, 'data'),
      caseInsensitiveRoot:  false,
      capabilitySigningKey: revision('k'),
      mode:                 'desktop',
      deviceId:             'synthetic-device',
      userId:               'synthetic-user',
      cloudUrl:             'https://invalid.test',
      paused:               false,
      modelDir:             join(root, 'models'),
      fileRoots:            [],
    };
    const manager = new LocalFilesManager(db, config);
    const collectionId = randomUUID();
    const fileId = randomUUID();
    const baseVersionId = randomUUID();
    const publicationVersionId = randomUUID();
    await db.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext)
      VALUES($1,'synthetic-user','Synthetic native publication','knowledge','desktop-only','{}','{}')`, [collectionId]);
    await db.query(`INSERT INTO files(id,collection_id,path,current_version_id,created_by_type,created_by_id)
      VALUES($1,$2,'synthetic.txt',NULL,'user','synthetic-user')`, [fileId, collectionId]);
    for (const [versionId, parentVersionId] of [[baseVersionId, null], [publicationVersionId, baseVersionId]]) {
      await db.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,size,created_by_type,created_by_id,device_id)
        VALUES($1,$2,$3,$4,0,'user','synthetic-user','synthetic-device')`, [versionId, fileId, collectionId, parentVersionId]);
    }
    await db.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, publicationVersionId]);

    const operationId = randomUUID();
    const originalRevision = revision('a');
    const originalHash = revision('b');
    const desiredHash = revision('c');
    const nextRevision = revision('d');
    await db.query(`INSERT INTO files_native_sources(source_handle,collection_id,file_id,display_name,source_revision,source_hash)
      VALUES($1,$2,$3,'synthetic.txt',$4,$5)`, [handle('h'), collectionId, fileId, originalRevision, originalHash]);
    await db.query(`INSERT INTO files_native_source_operations
      (operation_id,source_handle,direction,state,source_revision,source_hash,file_id,files_base_version_id,files_version_id,desired_hash)
      VALUES($1,$2,'publish','publishing',$3,$4,$5,$6,$7,$8)`,
    [operationId, handle('h'), originalRevision, originalHash, fileId, baseVersionId, publicationVersionId, desiredHash]);
    const proof:NativePublicationCompletionProof = {
      nextSourceRevision:     nextRevision,
      originalSourceRevision: originalRevision,
      originalSourceHash:     originalHash,
      currentSourceHash:      desiredHash,
      filesBaseVersionId:     baseVersionId,
      currentFilesVersionId:  publicationVersionId,
    };

    let lockedResolve!:()=>void;
    let releaseResolve!:()=>void;
    const locked = new Promise<void>(resolve => { lockedResolve = resolve });
    const release = new Promise<void>(resolve => { releaseResolve = resolve });
    const completionDb = {
      query:   db.query.bind(db),
      connect: async() => {
        const client = await db!.connect();
        return {
          query: async(sql:string, params?:any[]) => {
            const result = await client.query(sql, params);
            if (sql.startsWith('SELECT * FROM files_native_sources') && sql.includes('FOR UPDATE')) {
              lockedResolve();
              await release;
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    };
    const completion = new LocalFilesManager(completionDb as any, config).finishNativePublication(operationId, proof);
    await locked;

    const competing = await db.connect();
    try {
      await competing.query('BEGIN');
      await competing.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(competing.query('SELECT current_version_id FROM files WHERE id=$1 FOR UPDATE', [fileId]), /lock timeout/);
      await competing.query('ROLLBACK');
    } finally { competing.release() }
    releaseResolve();
    await completion;

    const committed = (await db.query(`SELECT f.current_version_id,n.source_revision,n.source_hash,n.state,o.state operation_state
      FROM files f JOIN files_native_sources n ON n.file_id=f.id JOIN files_native_source_operations o ON o.operation_id=$2 WHERE f.id=$1`,
    [fileId, operationId])).rows[0];
    assert.equal(committed.current_version_id, publicationVersionId);
    assert.equal(committed.source_revision, nextRevision);
    assert.equal(committed.source_hash, desiredHash);
    assert.equal(committed.state, 'active');
    assert.equal(committed.operation_state, 'completed');

    const recoveryOperationId = randomUUID();
    const recoveredHash = revision('e');
    const recoveredRevision = revision('f');
    await db.query(`INSERT INTO files_native_source_operations
      (operation_id,source_handle,direction,state,source_revision,source_hash,file_id,files_base_version_id,files_version_id,desired_hash)
      VALUES($1,$2,'publish','recovery-required',$3,$4,$5,$6,$7,$8)`,
    [recoveryOperationId, handle('h'), nextRevision, desiredHash, fileId, publicationVersionId, publicationVersionId, recoveredHash]);
    await manager.revalidateNativeSessions([]);
    assert.equal(await manager.reselectInterruptedNativePublication({
      fileId, previousHandle: handle('h'), handle: handle('i'), sourceRevision: recoveredRevision, sourceHash: recoveredHash,
    }), true);
    assert.deepEqual((await manager.nativePublicationActions()).map(action => [action.operationId, action.handle]), [[recoveryOperationId, handle('i')]]);

    await manager.revalidateNativeSessions([]);
    assert.equal(await manager.reselectInterruptedNativePublication({
      fileId, previousHandle: handle('i'), handle: handle('j'), sourceRevision: recoveredRevision, sourceHash: recoveredHash,
    }), true);
    await manager.revalidateNativeSessions([handle('j')]);
    const staleOperationId = randomUUID();
    await db.query(`INSERT INTO files_native_source_operations
      (operation_id,source_handle,direction,state,source_revision,source_hash,file_id,files_base_version_id,files_version_id,desired_hash)
      VALUES($1,$2,'publish','recovery-required',$3,$4,$5,$6,$7,$8)`,
    [staleOperationId, handle('z'), recoveredRevision, desiredHash, fileId, publicationVersionId, publicationVersionId, revision('9')]);
    assert.deepEqual((await manager.nativePublicationActions()).map(action => [action.operationId, action.handle]), [[recoveryOperationId, handle('j')]]);
  } finally {
    await db?.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    await run('pg_ctl', ['-D', cluster, '-m', 'immediate', '-w', 'stop']).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
