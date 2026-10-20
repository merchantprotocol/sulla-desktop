import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';

import { migrate } from './db.js';
import { NATIVE_SOURCE_PAGE_SQL, queryNativeSourcePage } from './nativeSourcePaging.js';
import { mirrorSystemAreaFile, type Queryable } from './systemAreaIngest.js';

const databaseUrl = process.env.SULLA_FILES_SYSTEM_INGEST_TEST_DATABASE_URL;
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : '';
const enabled = Boolean(databaseUrl && process.env.SULLA_FILES_ALLOW_DESTRUCTIVE_TESTS === '1' && /(^test_|_test$)/.test(databaseName));
const integration = enabled ? test : test.skip;
const SEEDED = 25_000;
const report = (line:string) => process.stdout.write(`# ${ line }\n`);

async function collection(db:pg.Pool, systemArea:string | null):Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,system_area,explorer_path)
    VALUES($1,'synthetic-owner',$2,'knowledge','desktop-only','org-readable','{}','{}',$3,$2)`, [id, `Synthetic ${ systemArea ?? 'user' }`, systemArea]);
  return id;
}

/** Minimal stand-in for app.ts insertVersion: manifest + version rows, then makes it current (the real index trigger fires). */
function insertVersionFor(collectionId:string, path:string, manifestHash:string, size:number) {
  return async(client:Queryable, existing?:{ id:string; current_version_id:string | null }) => {
    const fileId = existing?.id ?? (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size)
      VALUES($1,$2,'user','synthetic-owner','text/plain',$3) RETURNING id::text`, [collectionId, path, size])).rows[0].id;
    await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifestHash, '[]', size]);
    const versionId = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,device_id)
      VALUES($1,$2,$3,$4,$5,'user','synthetic-owner','synthetic-device') RETURNING id::text`, [fileId, collectionId, existing?.current_version_id ?? null, manifestHash, size])).rows[0].id;
    await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [fileId, versionId]);
    return { id: fileId, current_version_id: versionId };
  };
}

const lockNamespace = async(client:Queryable, id:string) => { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stored-namespace:${ id }`]) };

integration('system areas: plain ingest creates no native-source state, is idempotent, and native-source polling is O(page)', async() => {
  const db = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  try {
    await migrate(db);
    await db.query('TRUNCATE collections CASCADE');
    await db.query('TRUNCATE files_native_source_operations');
    const logs = await collection(db, 'logs');
    const sulla = await collection(db, 'sulla');
    const user = await collection(db, null);

    // (a) Seed 25,000 native sources + completed operations (what the live machine had) and compare the old full
    // inventory query with the keyset page the poller now uses.
    await db.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size)
      SELECT $1, 'app/seed-'||i||'.log', 'user', 'synthetic-owner', 'text/plain', 10 FROM generate_series(1,$2) i`, [user, SEEDED]);
    await db.query(`INSERT INTO files_native_sources(source_handle,collection_id,file_id,display_name,source_revision,source_hash,state,created_at)
      SELECT rpad(md5(f.path)||md5(f.path||'x'),43,'a'), f.collection_id, f.id, f.path, md5(f.path)||md5(f.path||'r'), md5(f.path)||md5(f.path||'h'),
        CASE WHEN row_number() OVER () % 1000 = 0 THEN 'reselect-required' ELSE 'active' END, NOW() - (row_number() OVER ())*INTERVAL '1 ms'
      FROM files f WHERE f.collection_id=$1`, [user]);
    await db.query(`INSERT INTO files_native_source_operations(operation_id,source_handle,direction,state,source_revision,source_hash,file_id)
      SELECT gen_random_uuid(), n.source_handle, 'ingest', 'completed', n.source_revision, n.source_hash, n.file_id FROM files_native_sources n`);
    await db.query('ANALYZE files; ANALYZE files_native_sources; ANALYZE files_native_source_operations');
    const time = async(sql:string, values:unknown[] = [], runs = 5) => {
      const started = process.hrtime.bigint();
      for (let run = 0; run < runs; run++) await db.query(sql, values);
      return Number(process.hrtime.bigint() - started) / 1e6 / runs;
    };
    const oldQuery = `SELECT n.file_id::text,f.current_version_id::text AS version_id,f.collection_id,f.path,n.source_handle,n.display_name,n.source_revision,n.source_hash,n.state,n.last_error,n.recovery
      FROM files_native_sources n JOIN files f ON f.id=n.file_id ORDER BY n.created_at`;
    const oldMs = await time(oldQuery);
    const pageMs = await time(NATIVE_SOURCE_PAGE_SQL, [null, null, 'active', 200]);
    const plan = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${ NATIVE_SOURCE_PAGE_SQL }`, [null, null, 'active', 200])).rows[0]['QUERY PLAN'][0];
    const planText = JSON.stringify(plan.Plan);
    report(`native-sources inventory with ${ SEEDED } rows: old full query ${ oldMs.toFixed(1) } ms/call, keyset page(200) ${ pageMs.toFixed(2) } ms/call`);
    assert.match(planText, /files_native_sources_created/, 'page query must use the created_at index');
    assert.doesNotMatch(planText, /"Node Type":"Sort"/, 'page query must not sort the table');
    assert.ok(pageMs * 5 < oldMs, `paged query (${ pageMs } ms) must be far cheaper than the full sort (${ oldMs } ms)`);

    // Keyset pages walk every row exactly once.
    let seen = 0; let after:string | undefined; const handles = new Set<string>();
    for (;;) {
      const page = await queryNativeSourcePage(db, { limit: 1_000, after });
      if (!page.length) break;
      for (const row of page) handles.add(row.handle);
      seen += page.length; after = page[page.length - 1].cursor;
    }
    assert.equal(seen, SEEDED); assert.equal(handles.size, SEEDED);

    const actionsSql = `SELECT o.operation_id::text FROM files_native_source_operations o
      JOIN files_native_sources n ON n.file_id=o.file_id JOIN files f ON f.id=o.file_id
      WHERE o.direction='publish' AND o.state IN('publishing','recovery-required') AND f.current_version_id=o.files_version_id
      ORDER BY o.created_at LIMIT 8`;
    const actionsMs = await time(actionsSql, [], 20);
    const actionsPlan = JSON.stringify((await db.query(`EXPLAIN (FORMAT JSON) ${ actionsSql }`)).rows[0]['QUERY PLAN'][0].Plan);
    report(`publication actions poll with ${ SEEDED } completed operations: ${ actionsMs.toFixed(2) } ms/call`);
    assert.match(actionsPlan, /files_native_source_operations_pending/, 'actions poll must use the pending partial index');

    // (c) Plain system-area ingest of 2,000 files: no native rows, logs skip the index, a second pass is a no-op.
    const nativeBefore = Number((await db.query('SELECT count(*) FROM files_native_sources')).rows[0].count);
    const opsBefore = Number((await db.query('SELECT count(*) FROM files_native_source_operations')).rows[0].count);
    const ingestAll = async(round:number) => {
      let created = 0; let unchanged = 0;
      const started = process.hrtime.bigint();
      for (let index = 0; index < 2_000; index++) {
        const [collectionId, path, skip] = index % 10 === 0 ? [sulla, `Docs/doc-${ index }.md`, false] : [logs, `app/log-${ index }.log`, true];
        const manifestHash = createHash('sha256').update(`content-${ index }-${ round === 3 && index === 5 ? 'changed' : 'same' }`).digest('hex');
        const result = await mirrorSystemAreaFile(db, { collectionId, path, manifestHash, skipSearchIndex: skip }, { lockNamespace, insertVersion: insertVersionFor(collectionId, path, manifestHash, 16) });
        if (result.unchanged) unchanged++; else created++;
      }
      return { created, unchanged, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    };
    const first = await ingestAll(1);
    const second = await ingestAll(2);
    const third = await ingestAll(3);
    report(`2,000 system-area files: first pass ${ first.ms.toFixed(0) } ms (${ (first.ms / 2_000).toFixed(2) } ms/file, ${ first.created } created); restart pass ${ second.ms.toFixed(0) } ms (${ second.unchanged } unchanged, ${ second.created } created); one changed file -> ${ third.created } new version`);
    assert.deepEqual([first.created, first.unchanged], [2_000, 0]);
    assert.deepEqual([second.created, second.unchanged], [0, 2_000]);
    assert.deepEqual([third.created, third.unchanged], [1, 1_999]);
    assert.equal(Number((await db.query('SELECT count(*) FROM files_native_sources')).rows[0].count), nativeBefore);
    assert.equal(Number((await db.query('SELECT count(*) FROM files_native_source_operations')).rows[0].count), opsBefore);
    const versions = Number((await db.query('SELECT count(*) FROM file_versions v JOIN files f ON f.id=v.file_id WHERE f.collection_id = ANY($1::uuid[])', [[logs, sulla]])).rows[0].count);
    assert.equal(versions, 2_001);
    const logJobs = Number((await db.query('SELECT count(*) FROM file_index_jobs j JOIN files f ON f.id=j.file_id WHERE f.collection_id=$1', [logs])).rows[0].count);
    const docJobs = Number((await db.query('SELECT count(*) FROM file_index_jobs j JOIN files f ON f.id=j.file_id WHERE f.collection_id=$1', [sulla])).rows[0].count);
    const unindexed = Number((await db.query("SELECT count(*) FROM files WHERE collection_id=$1 AND extraction_status='unsupported' AND extraction_reason_code='system_area_unindexed'", [logs])).rows[0].count);
    report(`index jobs: logs ${ logJobs } (skipped), docs ${ docJobs } (searchable); logs marked unindexed: ${ unindexed }`);
    assert.equal(logJobs, 0);
    assert.equal(docJobs, 200);
    assert.equal(unindexed, 1_800);
  } finally { await db.end() }
});
