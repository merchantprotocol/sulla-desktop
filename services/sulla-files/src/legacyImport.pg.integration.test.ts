import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { chunkId, encrypt, encryptChunk } from './crypto.js';
import { migrate } from './db.js';
import { LegacyFilesImporter } from './legacyImport.js';

const databaseUrl = process.env.SULLA_FILES_IMPORT_TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;

integration('publishes a complete retry-safe legacy snapshot in PostgreSQL', async() => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const root = await mkdtemp(join(tmpdir(), 'sulla-import-pg-'));
  const sourceRoot = join(root, 'legacy'); const chunkRoot = join(root, 'native');
  const legacyCollection = 'abcdefab-1234-4123-8123-abcdefabcdef';
  const emptyLegacyCollection = 'eeeeeeee-1234-4123-8123-eeeeeeeeeeee';
  const legacyDirectory = legacyCollection.toUpperCase();
  const nativeCollection = '12345678-1234-4123-8123-123456789abc';
  const legacyFile = '11111111-1111-4111-8111-111111111111';
  const nativeFile = '22222222-2222-4222-8222-222222222222';
  const unavailableFile = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';
  const childVersion = '10000000-0000-4000-8000-000000000001';
  const wrongSizeVersion = '30000000-0000-4000-8000-000000000003';
  const tombstoneVersion = '40000000-0000-4000-8000-000000000004';
  const parentVersion = 'f0000000-0000-4000-8000-000000000002';
  const nativeVersion = '50000000-0000-4000-8000-000000000005';
  const unavailableVersion = 'eeeeeeee-0000-4000-8000-eeeeeeeeeeee';
  const nativeMaster = randomBytes(32); const legacyMaster = randomBytes(32); const unavailableLegacyMaster = randomBytes(32); const legacySigningKey = randomBytes(32);
  const legacyData = createHmac('sha256', legacySigningKey).update(`sulla:files:data-key:v1:${ legacyCollection }`).digest();
  const legacyDedup = createHmac('sha256', legacySigningKey).update(`sulla:files:dedup-key:v1:${ legacyCollection }`).digest();
  const emptyLegacyData = randomBytes(32); const emptyLegacyDedup = randomBytes(32);
  const nativeData = randomBytes(32); const nativeDedup = randomBytes(32);
  try {
    await mkdir(sourceRoot); await mkdir(chunkRoot); await migrate(db);
    const legacyWrappedData = await encrypt(legacyData, unavailableLegacyMaster, `sulla:files:data-key:v1:${ legacyCollection }`);
    const legacyWrappedDedup = await encrypt(legacyDedup, unavailableLegacyMaster, `sulla:files:dedup-key:v1:${ legacyCollection }`);
    const emptyWrappedData = await encrypt(emptyLegacyData, unavailableLegacyMaster, `sulla:files:data-key:v1:${ emptyLegacyCollection }`);
    const emptyWrappedDedup = await encrypt(emptyLegacyDedup, unavailableLegacyMaster, `sulla:files:dedup-key:v1:${ emptyLegacyCollection }`);
    const nativeWrappedData = await encrypt(nativeData, nativeMaster, `sulla:files:data-key:v1:${ nativeCollection }`);
    const nativeWrappedDedup = await encrypt(nativeDedup, nativeMaster, `sulla:files:dedup-key:v1:${ nativeCollection }`);
    await db.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state,legacy_source)
      VALUES($1,'owner','Legacy','knowledge','desktop-only',$2,$3,'legacy-external-data',TRUE),
            ($4,'owner','Native chunks','knowledge','desktop-only',$5,$6,'native',FALSE),
            ($7,'owner','Empty legacy','knowledge','desktop-only',$8,$9,'legacy-external-data',TRUE)`,
    [legacyCollection, legacyWrappedData, legacyWrappedDedup, nativeCollection, nativeWrappedData, nativeWrappedDedup,
      emptyLegacyCollection, emptyWrappedData, emptyWrappedDedup]);
    await db.query("INSERT INTO files_collection_keys(collection_id,data_key,dedup_key,key_origin) VALUES($1,$2,$3,'random')", [nativeCollection, nativeWrappedData, nativeWrappedDedup]);
    await db.query(`INSERT INTO files(id,collection_id,path,deleted_at,created_by_type,created_by_id,mime,size)
      VALUES($1,$2,'Trash/history.txt',NOW(),'user','owner','text/plain',0),
            ($3,$2,'Native/reference.txt',NULL,'agent-run','run-1','text/plain',14),
            ($4,$5,'Unavailable/content.txt',NULL,'user','owner','text/plain',18)`,
    [legacyFile, legacyCollection, nativeFile, unavailableFile, emptyLegacyCollection]);

    const legacyPlain = Buffer.from('legacy exact bytes'); const legacyChunk = chunkId(legacyPlain, legacyDedup);
    const legacyManifest = createHash('sha256').update(JSON.stringify({ ids: [legacyChunk], size: legacyPlain.length })).digest('hex');
    // The retired container stored legacy ciphertext in the service chunk
    // volume, even though its key metadata now classifies it as external.
    const legacyPath = join(chunkRoot, legacyDirectory, legacyChunk.slice(0, 2));
    await mkdir(legacyPath, { recursive: true }); await writeFile(join(legacyPath, legacyChunk), await encryptChunk(legacyPlain, legacyData, legacyChunk));
    const nativePlain = Buffer.from('native ref data'); const nativeChunk = chunkId(nativePlain, nativeDedup);
    const nativeManifest = createHash('sha256').update(JSON.stringify({ ids: [nativeChunk], size: nativePlain.length })).digest('hex');
    const nativePath = join(chunkRoot, nativeCollection, nativeChunk.slice(0, 2));
    await mkdir(nativePath, { recursive: true }); await writeFile(join(nativePath, nativeChunk), await encryptChunk(nativePlain, nativeData, nativeChunk));
    const unavailablePlain = Buffer.from('unavailable content'); const unavailableChunk = chunkId(unavailablePlain, emptyLegacyDedup);
    const unavailableManifest = createHash('sha256').update(JSON.stringify({ ids: [unavailableChunk], size: unavailablePlain.length })).digest('hex');
    const unavailablePath = join(chunkRoot, emptyLegacyCollection, unavailableChunk.slice(0, 2));
    await mkdir(unavailablePath, { recursive: true }); await writeFile(join(unavailablePath, unavailableChunk), await encryptChunk(unavailablePlain, emptyLegacyData, unavailableChunk));
    await db.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3),($4,$5,$6),($7,$8,$9)',
      [legacyManifest, JSON.stringify([legacyChunk]), legacyPlain.length, nativeManifest, JSON.stringify([nativeChunk]), nativePlain.length,
        unavailableManifest, JSON.stringify([unavailableChunk]), unavailablePlain.length]);
    const at = new Date('2026-01-01T00:00:00Z');
    await db.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id) VALUES
      ($1,$5,$6,$4,$7,$8,FALSE,'user','owner',$11,'child-before-parent','device-a',$4),
      ($2,$5,$6,NULL,$7,$9,FALSE,'user','owner',$11,'cached-size-check','device-a',NULL),
      ($3,$5,$6,$1,NULL,0,TRUE,'user','owner',$11,'trash','device-a',$1),
      ($4,$5,$6,NULL,$7,$8,FALSE,'agent-run','run-1',$11,'parent','device-b',NULL),
      ($10,$12,$13,NULL,$14,$15,FALSE,'agent-run','run-1',$11,'native-cross-collection','device-c',NULL)`,
    [childVersion, wrongSizeVersion, tombstoneVersion, parentVersion, legacyFile, legacyCollection, legacyManifest, legacyPlain.length,
      legacyPlain.length + 1, nativeVersion, at, nativeFile, nativeCollection, nativeManifest, nativePlain.length]);
    await db.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,created_at,message,device_id)
      VALUES($1,$2,$3,$4,$5,'user','owner',$6,'must-fail-closed','device-d')`,
    [unavailableVersion, unavailableFile, emptyLegacyCollection, unavailableManifest, unavailablePlain.length, at]);
    await db.query('UPDATE files SET current_version_id=CASE id WHEN $1 THEN $2::uuid ELSE $3::uuid END WHERE id IN($1,$4)', [legacyFile, tombstoneVersion, nativeVersion, nativeFile]);
    await db.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [unavailableFile, unavailableVersion]);
    await db.query("INSERT INTO journal(collection_id,file_id,version_id,op,at) VALUES($1,$2,$3,'delete',$4)", [legacyCollection, legacyFile, tombstoneVersion, at]);
    await db.query("INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,at,details,org_id) VALUES('user','owner','device-a',$1,$2,'get',$3,$4,'org-a')", [legacyFile, childVersion, at, { source: 'legacy' }]);
    await db.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES
      ('user','owner','file',$1,'created_by','owner'),('file',$1,'agent-run','run-1','created_by','owner')`, [legacyFile]);

    const importer = new LegacyFilesImporter(db, sourceRoot, chunkRoot, legacySigningKey);
    await assert.rejects(importer.run(nativeMaster, [legacyMaster]), (error:unknown) => {
      return error instanceof Error && 'stage' in error && 'reason' in error &&
        error.stage === 'conversion' && error.reason === 'CHUNK_VERIFICATION_FAILED';
    });
    // Make that synthetic collection genuinely empty. Its unavailable key must
    // no longer block the unrelated authenticated collection, while the prior
    // assertion proves content-bearing collections are never skipped.
    await db.query('DELETE FROM files_legacy_version_map WHERE source_version_id=$1', [unavailableVersion]);
    await db.query('DELETE FROM files_legacy_file_map WHERE source_file_id=$1', [unavailableFile]);
    await db.query('DELETE FROM files_protected_files WHERE file_id=$1', [unavailableFile]);
    await db.query('UPDATE files SET current_version_id=NULL WHERE id=$1', [unavailableFile]);
    await db.query('DELETE FROM file_versions WHERE id=$1', [unavailableVersion]);
    await db.query('DELETE FROM files WHERE id=$1', [unavailableFile]);
    await db.query('DELETE FROM manifests WHERE hash=$1', [unavailableManifest]);
    await rm(join(chunkRoot, emptyLegacyCollection), { recursive: true });
    await assert.rejects(importer.run(nativeMaster, [legacyMaster]), (error:unknown) => {
      return error instanceof Error && 'stage' in error && 'reason' in error &&
        error.stage === 'conversion' && error.reason === 'VERSION_SIZE_VERIFICATION_FAILED';
    });
    assert.equal((await db.query('SELECT count(*)::int count FROM files_legacy_collection_map m JOIN collections shadow ON shadow.id=m.shadow_collection_id WHERE shadow.published=FALSE')).rows[0].count, 3);
    assert.equal((await db.query('SELECT count(*)::int count FROM files f JOIN files_legacy_file_map fm ON fm.shadow_file_id=f.id')).rows[0].count, 0);
    await db.query('UPDATE file_versions SET size=$2 WHERE id=$1', [wrongSizeVersion, legacyPlain.length]);
    const result = await importer.run(nativeMaster, [legacyMaster]);
    assert.deepEqual(result, { collections: 3, files: 2, versions: 5 });
    const mapped = (await db.query(`SELECT source.id source_id,shadow.id shadow_id,shadow.current_version_id,vm.shadow_version_id expected_current
      FROM files source JOIN files_legacy_file_map fm ON fm.source_file_id=source.id JOIN files shadow ON shadow.id=fm.shadow_file_id
      LEFT JOIN files_legacy_version_map vm ON vm.source_version_id=source.current_version_id ORDER BY source.id`)).rows;
    assert.equal(mapped.length, 2); assert.ok(mapped.every(row => row.current_version_id === row.expected_current));
    const lineage = (await db.query(`SELECT child.parent_version_id,parent.shadow_version_id,child.base_server_version_id
      FROM files_legacy_version_map current JOIN file_versions child ON child.id=current.shadow_version_id
      JOIN files_legacy_version_map parent ON parent.source_version_id=$1 WHERE current.source_version_id=$2`, [parentVersion, childVersion])).rows[0];
    assert.equal(lineage.parent_version_id, lineage.shadow_version_id); assert.equal(lineage.base_server_version_id, lineage.shadow_version_id);
    const edges = (await db.query(`SELECT e.src_type,e.src_id,e.dst_type,e.dst_id FROM edges e JOIN files_legacy_file_map fm ON e.src_id=fm.shadow_file_id::text OR e.dst_id=fm.shadow_file_id::text`)).rows;
    assert.equal(edges.length, 2); assert.ok(edges.some(edge => edge.src_type === 'user')); assert.ok(edges.some(edge => edge.dst_type === 'agent-run'));
    assert.equal((await db.query('SELECT count(*)::int count FROM journal j JOIN files_legacy_file_map fm ON fm.shadow_file_id=j.file_id')).rows[0].count, 1);
    assert.equal((await db.query('SELECT count(*)::int count FROM files_legacy_audit_map')).rows[0].count, 1);
    const nativeEdit = '60000000-0000-4000-8000-000000000006';
    const shadow = (await db.query(`SELECT fm.shadow_file_id,vm.shadow_version_id,m.shadow_collection_id,v.manifest_hash
      FROM files_legacy_file_map fm JOIN files_legacy_version_map vm ON vm.source_version_id=$1
      JOIN files_legacy_collection_map m ON m.source_collection_id=$2 JOIN file_versions v ON v.id=vm.shadow_version_id
      WHERE fm.source_file_id=$3`, [childVersion, legacyCollection, legacyFile])).rows[0];
    await db.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id)
      VALUES($1,$2,$3,$4,$5,$6,'user','owner','post-import native edit','native-device',$4)`,
    [nativeEdit, shadow.shadow_file_id, shadow.shadow_collection_id, shadow.shadow_version_id, shadow.manifest_hash, legacyPlain.length]);
    await db.query("UPDATE files SET current_version_id=$2,path='Native/renamed-after-import.txt',search_text='native metadata' WHERE id=$1", [shadow.shadow_file_id, nativeEdit]);
    await db.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'group','post-import-group','view')", [shadow.shadow_collection_id]);
    await db.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1', [shadow.shadow_collection_id]);
    const beforeRetry = (await db.query(`SELECT f.current_version_id,f.path,f.search_text,
      (SELECT count(*)::int FROM collection_acl WHERE collection_id=$2) acl_count,
      (SELECT jsonb_object_agg(id,refcount) FROM chunks WHERE collection_id=$2) refcounts FROM files f WHERE f.id=$1`, [shadow.shadow_file_id, shadow.shadow_collection_id])).rows[0];
    assert.equal((await importer.run(nativeMaster, [legacyMaster])).versions, 5);
    const afterRetry = (await db.query(`SELECT f.current_version_id,f.path,f.search_text,
      (SELECT count(*)::int FROM collection_acl WHERE collection_id=$2) acl_count,
      (SELECT jsonb_object_agg(id,refcount) FROM chunks WHERE collection_id=$2) refcounts FROM files f WHERE f.id=$1`, [shadow.shadow_file_id, shadow.shadow_collection_id])).rows[0];
    assert.deepEqual(afterRetry, beforeRetry); assert.equal(afterRetry.current_version_id, nativeEdit);
  } finally {
    for (const key of [nativeMaster, legacyMaster, unavailableLegacyMaster, legacySigningKey, legacyData, legacyDedup, emptyLegacyData, emptyLegacyDedup, nativeData, nativeDedup]) key.fill(0);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});
