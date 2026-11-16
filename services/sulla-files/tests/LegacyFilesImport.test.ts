// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Characterizes the legacy (pre-Files runtime) import end to end: preflight classification,
// staging, chunk conversion and atomic publication, against a real Postgres schema built by
// the real migrations and a real on-disk legacy chunk layout. Point SULLA_FILES_TEST_DATABASE_URL
// at a throwaway database (e.g. `docker run --rm -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:16-alpine`).
// Each run creates and drops its own schema.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { chunkId, decrypt, decryptChunk, encrypt, encryptChunk, type Envelope } from '../src/crypto.js';
import { migrate } from '../src/db.js';
import { LegacyFilesImporter, LegacyImportDataError } from '../src/legacyImport.js';
import { isLegacyInternalPath, runLegacyPreflight } from '../src/legacyPreflight.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const manifestHash = (ids:string[], size:number) => createHash('sha256').update(JSON.stringify({ ids, size })).digest('hex');

interface LegacyCollection { id:string; data:Buffer; dedup:Buffer }

/** Writes data exactly the way the retired in-process runtime left it: rows plus an external chunk tree. */
class LegacyStoreFixture {
  readonly legacyMaster = randomBytes(32);
  readonly nativeMaster = randomBytes(32);
  readonly chunkFiles = new Map<string, string>();

  constructor(private readonly pool:pg.Pool, readonly filesRoot:string, readonly sourceRoot:string, readonly chunkRoot:string) {}

  async collection(name:string):Promise<LegacyCollection> {
    const id = randomUUID(); const data = randomBytes(32); const dedup = randomBytes(32);
    await this.pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,compatibility_state,legacy_source)
      VALUES($1,'u1',$2,'knowledge','desktop-only',$3,$4,'legacy-external-data',TRUE)`,
    [id, name, await encrypt(data, this.legacyMaster, `sulla:files:data-key:v1:${ id }`), await encrypt(dedup, this.legacyMaster, `sulla:files:dedup-key:v1:${ id }`)]);
    return { id, data, dedup };
  }

  /** One legacy version; returns its id. `parts` are the plaintext chunks in order. */
  async version(collection:LegacyCollection, fileId:string, parts:string[], parentId:string | null):Promise<string> {
    const ids:string[] = []; let size = 0;
    for (const part of parts) {
      const plain = Buffer.from(part); const id = chunkId(plain, collection.dedup); const encrypted = await encryptChunk(plain, collection.data, id);
      const directory = join(this.sourceRoot, collection.id, id.slice(0, 2)); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, id), encrypted); this.chunkFiles.set(id, join(directory, id));
      await this.pool.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT DO NOTHING`,
        [collection.id, id, plain.length, encrypted.length, `legacy/${ id }`]);
      ids.push(id); size += plain.length;
    }
    const hash = manifestHash(ids, size);
    await this.pool.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [hash, JSON.stringify(ids), size]);
    const versionId = randomUUID();
    await this.pool.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,device_id,message)
      VALUES($1,$2,$3,$4,$5,$6,'user','u1','legacy-device','legacy save')`, [versionId, fileId, collection.id, parentId, hash, size]);
    await this.pool.query('UPDATE files SET current_version_id=$2,size=$3 WHERE id=$1', [fileId, versionId, size]);
    await this.pool.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [collection.id, fileId, versionId]);
    await this.pool.query("INSERT INTO audit_log(who_type,who_id,file_id,version_id,action) VALUES('user','u1',$1,$2,'file.write')", [fileId, versionId]);
    return versionId;
  }

  /** A legacy file with two versions (lineage) whose current content is `v2.join('')`. */
  async file(collection:LegacyCollection, path:string, v1:string[], v2:string[]):Promise<{ fileId:string; versions:string[] }> {
    const fileId = (await this.pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime) VALUES($1,$2,'user','u1','text/plain') RETURNING id`, [collection.id, path])).rows[0].id;
    const first = await this.version(collection, fileId, v1, null);
    const second = await this.version(collection, fileId, v2, first);
    return { fileId, versions: [first, second] };
  }

  importer():LegacyFilesImporter { return new LegacyFilesImporter(this.pool, this.sourceRoot, this.chunkRoot) }

  /** Plaintext of the shadow file's current version, decrypted with the native (shadow) collection key. */
  async shadowContent(sourceFileId:string):Promise<{ path:string; content:string; collectionId:string }> {
    const row = (await this.pool.query(`SELECT shadow.path,shadow.collection_id::text collection_id,m.chunk_ids,k.data_key FROM files_legacy_file_map fm
      JOIN files shadow ON shadow.id=fm.shadow_file_id JOIN file_versions v ON v.id=shadow.current_version_id JOIN manifests m ON m.hash=v.manifest_hash
      JOIN files_collection_keys k ON k.collection_id=shadow.collection_id WHERE fm.source_file_id=$1`, [sourceFileId])).rows[0];
    const key = Buffer.from(await decrypt(row.data_key as Envelope, this.nativeMaster, `sulla:files:data-key:v1:${ row.collection_id }`));
    const parts:Buffer[] = [];
    for (const id of row.chunk_ids as string[]) parts.push(await decryptChunk(await readFile(join(this.chunkRoot, row.collection_id, id.slice(0, 2), id)), key, id));
    return { path: row.path, content: Buffer.concat(parts).toString(), collectionId: row.collection_id };
  }

  async counts():Promise<Record<string, number>> {
    return (await this.pool.query(`SELECT (SELECT count(*)::int FROM collections) collections,(SELECT count(*)::int FROM files) files,
      (SELECT count(*)::int FROM file_versions) versions,(SELECT count(*)::int FROM chunks) chunks,(SELECT count(*)::int FROM journal) journal,
      (SELECT count(*)::int FROM audit_log) audits,(SELECT count(*)::int FROM edges) edges`)).rows[0];
  }
}

describe('legacy internal path containment', () => {
  // risk: data exposure — the retired ciphertext tree must never be watched, indexed or shared.
  it('matches the protected prefix and its children case-insensitively, and nothing else', () => {
    const status = { state: 'secure-import-required' as const, protectedPrefix: 'chunks' };
    expect(isLegacyInternalPath('chunks', status)).toBe(true);
    expect(isLegacyInternalPath('/Chunks/ab/cd/', status)).toBe(true);
    expect(isLegacyInternalPath('chunks\\00\\x', status)).toBe(true);
    expect(isLegacyInternalPath('chunks-old/x', status)).toBe(false);
    expect(isLegacyInternalPath('docs/chunks', status)).toBe(false);
    expect(isLegacyInternalPath('chunks/x', { state: 'clear' })).toBe(false);
  });
});

describe.skipIf(!databaseUrl)('legacy Files preflight and import (real Postgres)', () => {
  const schema = `files_legacy_spec_${ randomUUID().replaceAll('-', '') }`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  let pool:pg.Pool;
  let root = '';
  let fixture:LegacyStoreFixture;

  beforeAll(async() => {
    await admin.query(`CREATE SCHEMA ${ schema }`);
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${ schema },public` });
    await migrate(pool);
  }, 30_000);
  afterAll(async() => { await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS ${ schema } CASCADE`); await admin.end() });
  beforeEach(async() => {
    await pool.query(`TRUNCATE collections, files_legacy_imports, files_legacy_preflight, files_key_state, edges, manifests CASCADE`);
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), 'sulla-legacy-import-'));
    const filesRoot = join(root, 'files'); const chunkRoot = join(root, 'native-chunks');
    await mkdir(filesRoot, { recursive: true }); await mkdir(chunkRoot, { recursive: true });
    fixture = new LegacyStoreFixture(pool, filesRoot, join(filesRoot, 'chunks'), chunkRoot);
  });

  // risk: data exposure — a database with no retired data must unlock without containment.
  it('reports clear when no legacy rows or chunk layout exist', async() => {
    expect(await runLegacyPreflight(pool, fixture.filesRoot)).toEqual({ state: 'clear' });
    const row = (await pool.query('SELECT state,protected_prefix FROM files_legacy_preflight')).rows[0];
    expect(row).toEqual({ state: 'clear', protected_prefix: null });
  });

  // risk: data exposure — retired ciphertext must be detected, contained and protected before unlock.
  it('requires secure import and protects watched files under the retired chunk tree', async() => {
    const collection = await fixture.collection('Old docs');
    await fixture.file(collection, 'notes/plan.md', ['draft'], ['final ', 'plan']);
    const watchedCollection = randomUUID();
    await pool.query(`INSERT INTO collections(id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext) VALUES($1,'u1','Files','knowledge','desktop-only','{}','{}')`, [watchedCollection]);
    await pool.query('INSERT INTO files_collection_keys(collection_id,data_key,dedup_key) VALUES($1,$2,$3)', [watchedCollection, await encrypt(randomBytes(32), fixture.nativeMaster, 'x'), await encrypt(randomBytes(32), fixture.nativeMaster, 'y')]);
    const inside = (await pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id) VALUES($1,'Chunks/ab/cipher','user','u1') RETURNING id`, [watchedCollection])).rows[0].id;
    const outside = (await pool.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id) VALUES($1,'chunks-notes.md','user','u1') RETURNING id`, [watchedCollection])).rows[0].id;
    await pool.query("INSERT INTO watched_folder_state(root_id,collection_id,path,file_id,content_hash,size,mtime_ms) SELECT 'default',$1,path,id,'h',1,1 FROM files WHERE id IN ($2,$3)", [watchedCollection, inside, outside]);

    const status = await runLegacyPreflight(pool, fixture.filesRoot);
    expect(status).toMatchObject({ state: 'secure-import-required', protectedPrefix: 'chunks', code: 'FILES_LEGACY_SECURE_IMPORT_REQUIRED' });
    const protectedIds = (await pool.query('SELECT file_id::text FROM files_protected_files')).rows.map(row => row.file_id);
    expect(protectedIds).toContain(inside);
    expect(protectedIds).not.toContain(outside);
    // A second check never downgrades containment while the import is outstanding.
    expect((await runLegacyPreflight(pool, fixture.filesRoot)).state).toBe('secure-import-required');
  });

  // risk: data loss / integrity — every legacy version must arrive re-encrypted, with lineage, history and audit intact.
  it('imports legacy files into native shadows that decrypt to the original content', async() => {
    const collection = await fixture.collection('Old docs');
    const plan = await fixture.file(collection, 'notes/plan.md', ['draft'], ['final ', 'plan']);
    const todo = await fixture.file(collection, 'todo.txt', ['a'], ['b', 'c', 'd']);
    await pool.query("INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES('file',$1,'file',$2,'links_to','u1')", [plan.fileId, todo.fileId]);
    expect((await runLegacyPreflight(pool, fixture.filesRoot)).state).toBe('secure-import-required');

    expect(await fixture.importer().run(fixture.nativeMaster, [fixture.legacyMaster])).toEqual({ collections: 1, files: 2, versions: 4 });

    expect(await fixture.shadowContent(plan.fileId)).toMatchObject({ path: 'notes/plan.md', content: 'final plan' });
    expect((await fixture.shadowContent(todo.fileId)).content).toBe('bcd');
    const shadowVersions = (await pool.query(`SELECT shadow.parent_version_id::text parent,parent.shadow_version_id::text expected FROM files_legacy_version_map vm
      JOIN file_versions source ON source.id=vm.source_version_id JOIN file_versions shadow ON shadow.id=vm.shadow_version_id
      LEFT JOIN files_legacy_version_map parent ON parent.source_version_id=source.parent_version_id WHERE source.file_id=$1 ORDER BY source.created_at`, [plan.fileId])).rows;
    expect(shadowVersions).toEqual([{ parent: null, expected: null }, { parent: shadowVersions[1].expected, expected: expect.any(String) }]);
    expect((await pool.query('SELECT count(*)::int n FROM files_legacy_audit_map')).rows[0].n).toBe(4);
    expect((await pool.query("SELECT count(*)::int n FROM edges e JOIN files_legacy_file_map a ON a.shadow_file_id::text=e.src_id JOIN files_legacy_file_map b ON b.shadow_file_id::text=e.dst_id")).rows[0].n).toBe(1);
    const shadow = (await pool.query('SELECT c.published,c.legacy_source,c.compatibility_state FROM files_legacy_collection_map m JOIN collections c ON c.id=m.shadow_collection_id')).rows;
    expect(shadow).toEqual([{ published: true, legacy_source: false, compatibility_state: 'native' }]);
    expect((await pool.query('SELECT state FROM files_legacy_imports')).rows[0].state).toBe('completed');
    expect((await pool.query('SELECT 1 FROM files_key_state')).rowCount).toBe(1);
    // Converted data clears containment; the ciphertext prefix stays excluded from watcher/search paths.
    expect(await runLegacyPreflight(pool, fixture.filesRoot)).toEqual({ state: 'clear' });
    expect((await pool.query('SELECT protected_prefix FROM files_legacy_preflight')).rows[0].protected_prefix).toBe('chunks');
  });

  // risk: duplicated data — re-running a completed import must import nothing twice.
  it('is idempotent: a second run returns the same result and writes no rows', async() => {
    const collection = await fixture.collection('Old docs');
    await fixture.file(collection, 'a.md', ['one'], ['two']);
    const first = await fixture.importer().run(fixture.nativeMaster, [fixture.legacyMaster]);
    const after = await fixture.counts();
    const second = await fixture.importer().run(fixture.nativeMaster, [fixture.legacyMaster]);
    expect(second).toEqual(first);
    expect(await fixture.counts()).toEqual(after);
    expect(await fixture.importer().completedResult()).toEqual(first);
  });

  // risk: data loss after a crash — a failed import must publish nothing, then resume on the same shadows.
  it('publishes nothing when a chunk is missing, then resumes on the staged shadows once it is restored', async() => {
    const collection = await fixture.collection('Old docs');
    const file = await fixture.file(collection, 'a.md', ['one'], ['two', 'three']);
    const missing = fixture.chunkFiles.get(chunkId(Buffer.from('three'), collection.dedup))!;
    await rename(missing, `${ missing }.away`);

    await expect(fixture.importer().run(fixture.nativeMaster, [fixture.legacyMaster])).rejects.toBeInstanceOf(LegacyImportDataError);
    const staged = (await pool.query('SELECT shadow_collection_id::text id,published_at FROM files_legacy_collection_map')).rows;
    expect(staged).toEqual([{ id: expect.any(String), published_at: null }]);
    expect((await pool.query('SELECT count(*)::int n FROM files WHERE collection_id=$1', [staged[0].id])).rows[0].n).toBe(0);
    expect((await pool.query('SELECT state FROM files_legacy_imports')).rows[0].state).toBe('staging');
    expect(await fixture.importer().completedResult()).toBeUndefined();

    await rename(`${ missing }.away`, missing);
    expect(await fixture.importer().run(fixture.nativeMaster, [fixture.legacyMaster])).toEqual({ collections: 1, files: 1, versions: 2 });
    const shadow = await fixture.shadowContent(file.fileId);
    expect(shadow).toMatchObject({ content: 'twothree', collectionId: staged[0].id });
    expect((await pool.query('SELECT count(*)::int n FROM files_legacy_collection_map')).rows[0].n).toBe(1);
  });

  // risk: data exposure — data that fails authentication is quarantined, never published, never unlocked.
  it('rejects a wrong legacy master as quarantinable and contains the failed sources', async() => {
    const collection = await fixture.collection('Old docs');
    const file = await fixture.file(collection, 'secret.md', ['x'], ['y']);
    const importer = fixture.importer();
    await expect(importer.run(fixture.nativeMaster, [randomBytes(32)])).rejects.toBeInstanceOf(LegacyImportDataError);
    expect((await pool.query('SELECT count(*)::int n FROM files_legacy_file_map fm JOIN files f ON f.id=fm.shadow_file_id')).rows[0].n).toBe(0);

    await importer.containFailedSources();
    expect((await pool.query('SELECT state,reason FROM files_legacy_preflight')).rows[0]).toEqual({ state: 'secure-import-required', reason: 'quarantined-import-validation' });
    expect((await pool.query('SELECT 1 FROM files_protected_files WHERE file_id=$1', [file.fileId])).rowCount).toBe(1);
    expect((await pool.query('SELECT published FROM collections WHERE id=$1', [collection.id])).rows[0].published).toBe(false);
  });

  // risk: key misuse — malformed key material is a hard failure, not a quarantine.
  it('refuses malformed key material without touching the database', async() => {
    await fixture.collection('Old docs');
    const error = await fixture.importer().run(Buffer.alloc(16), [fixture.legacyMaster]).catch(failure => failure);
    expect(error).not.toBeInstanceOf(LegacyImportDataError);
    expect(error.message).toBe('Invalid Files import key material');
    expect((await pool.query('SELECT count(*)::int n FROM files_legacy_collection_map')).rows[0].n).toBe(0);
  });
});
