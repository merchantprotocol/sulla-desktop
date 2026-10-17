import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
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
  const legacyDirectory = legacyCollection.toUpperCase();
  const nativeCollection = '12345678-1234-4123-8123-123456789abc';
  const legacyFile = '11111111-1111-4111-8111-111111111111';
  const nativeFile = '22222222-2222-4222-8222-222222222222';
  const childVersion = '10000000-0000-4000-8000-000000000001';
  const wrongSizeVersion = '30000000-0000-4000-8000-000000000003';
  const tombstoneVersion = '40000000-0000-4000-8000-000000000004';
  const parentVersion = 'f0000000-0000-4000-8000-000000000002';
  const nativeVersion = '50000000-0000-4000-8000-000000000005';
  const nativeMaster = randomBytes(32); const legacyMaster = randomBytes(32);
  const legacyData = randomBytes(32); const legacyDedup = randomBytes(32);
  const nativeData = randomBytes(32); const nativeDedup = randomBytes(32);
  try {
    await mkdir(sourceRoot); await mkdir(chunkRoot); await migrate(db);
    const legacyWrappedData = await encrypt(legacyData, legacyMaster, `sulla:files:data-key:v1:${ legacyCollection }`);
    const legacyWrappedDedup = await encrypt(legacyDedup, legacyMaster, `sulla:files:dedup-key:v1:${ legacyCollection }`);
    const nativeWrappedData = await encrypt(nativeData, nativeMaster, `sulla:files:data-key:v1:${ nativeCollection }`);
    const nativeWrappedDedup = await encrypt(nativeDedup, nativeMaster, `sulla:files:dedup-key:v1:${ nativeCollection }`);
    await db.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state,legacy_source)
      VALUES($1,'owner','Legacy','knowledge','desktop-only',$2,$3,'legacy-external-data',TRUE),
            ($4,'owner','Native chunks','knowledge','desktop-only',$5,$6,'native',FALSE)`,
    [legacyCollection, legacyWrappedData, legacyWrappedDedup, nativeCollection, nativeWrappedData, nativeWrappedDedup]);
    await db.query("INSERT INTO files_collection_keys(collection_id,data_key,dedup_key,key_origin) VALUES($1,$2,$3,'random')", [nativeCollection, nativeWrappedData, nativeWrappedDedup]);
    await db.query(`INSERT INTO files(id,collection_id,path,deleted_at,created_by_type,created_by_id,mime,size)
      VALUES($1,$2,'Trash/history.txt',NOW(),'user','owner','text/plain',0),
            ($3,$2,'Native/reference.txt',NULL,'agent-run','run-1','text/plain',14)`,
    [legacyFile, legacyCollection, nativeFile]);

    const legacyPlain = Buffer.from('legacy exact bytes'); const legacyChunk = chunkId(legacyPlain, legacyDedup);
    const legacyManifest = createHash('sha256').update(JSON.stringify({ ids: [legacyChunk], size: legacyPlain.length })).digest('hex');
    const legacyPath = join(sourceRoot, legacyDirectory, legacyChunk.slice(0, 2));
    await mkdir(legacyPath, { recursive: true }); await writeFile(join(legacyPath, legacyChunk), await encryptChunk(legacyPlain, legacyData, legacyChunk));
    const nativePlain = Buffer.from('native ref data'); const nativeChunk = chunkId(nativePlain, nativeDedup);
    const nativeManifest = createHash('sha256').update(JSON.stringify({ ids: [nativeChunk], size: nativePlain.length })).digest('hex');
    const nativePath = join(chunkRoot, nativeCollection, nativeChunk.slice(0, 2));
    await mkdir(nativePath, { recursive: true }); await writeFile(join(nativePath, nativeChunk), await encryptChunk(nativePlain, nativeData, nativeChunk));
    await db.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3),($4,$5,$6)',
      [legacyManifest, JSON.stringify([legacyChunk]), legacyPlain.length, nativeManifest, JSON.stringify([nativeChunk]), nativePlain.length]);
    const at = new Date('2026-01-01T00:00:00Z');
    await db.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id) VALUES
      ($1,$5,$6,$4,$7,$8,FALSE,'user','owner',$11,'child-before-parent','device-a',$4),
      ($2,$5,$6,NULL,$7,$9,FALSE,'user','owner',$11,'cached-size-check','device-a',NULL),
      ($3,$5,$6,$1,NULL,0,TRUE,'user','owner',$11,'trash','device-a',$1),
      ($4,$5,$6,NULL,$7,$8,FALSE,'agent-run','run-1',$11,'parent','device-b',NULL),
      ($10,$12,$13,NULL,$14,$15,FALSE,'agent-run','run-1',$11,'native-cross-collection','device-c',NULL)`,
    [childVersion, wrongSizeVersion, tombstoneVersion, parentVersion, legacyFile, legacyCollection, legacyManifest, legacyPlain.length,
      legacyPlain.length + 1, nativeVersion, at, nativeFile, nativeCollection, nativeManifest, nativePlain.length]);
    await db.query('UPDATE files SET current_version_id=CASE id WHEN $1 THEN $2::uuid ELSE $3::uuid END WHERE id IN($1,$4)', [legacyFile, tombstoneVersion, nativeVersion, nativeFile]);
    await db.query("INSERT INTO journal(collection_id,file_id,version_id,op,at) VALUES($1,$2,$3,'delete',$4)", [legacyCollection, legacyFile, tombstoneVersion, at]);
    await db.query("INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,at,details,org_id) VALUES('user','owner','device-a',$1,$2,'get',$3,$4,'org-a')", [legacyFile, childVersion, at, { source: 'legacy' }]);
    await db.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES
      ('user','owner','file',$1,'created_by','owner'),('file',$1,'agent-run','run-1','created_by','owner')`, [legacyFile]);

    const importer = new LegacyFilesImporter(db, sourceRoot, chunkRoot);
    await assert.rejects(importer.run(nativeMaster, [legacyMaster]), /version size verification failed/);
    assert.equal((await db.query('SELECT count(*)::int count FROM files_legacy_collection_map m JOIN collections shadow ON shadow.id=m.shadow_collection_id WHERE shadow.published=FALSE')).rows[0].count, 2);
    assert.equal((await db.query('SELECT count(*)::int count FROM files f JOIN files_legacy_file_map fm ON fm.shadow_file_id=f.id')).rows[0].count, 0);
    await db.query('UPDATE file_versions SET size=$2 WHERE id=$1', [wrongSizeVersion, legacyPlain.length]);
    const result = await importer.run(nativeMaster, [legacyMaster]);
    assert.deepEqual(result, { collections: 2, files: 2, versions: 5 });
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
    assert.equal((await importer.run(nativeMaster, [legacyMaster])).versions, 5);
  } finally {
    for (const key of [nativeMaster, legacyMaster, legacyData, legacyDedup, nativeData, nativeDedup]) key.fill(0);
    await db.end(); await rm(root, { recursive: true, force: true });
  }
});
