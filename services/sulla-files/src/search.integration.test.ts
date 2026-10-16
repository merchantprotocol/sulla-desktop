import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

import { searchableScopes } from './acl.js';
import { migrate } from './db.js';
import { desktopIndexSource } from './indexSource.js';
import { IndexingQueue } from './indexing.js';
import { PotionEmbedder } from './potionEmbedder.js';
import { FileSearch } from './search.js';

const databaseUrl = process.env.SULLA_FILES_TEST_DATABASE_URL;
const modelDir = process.env.SULLA_FILES_EMBEDDING_MODEL_DIR;
const enabled = Boolean(databaseUrl && modelDir);
async function harness() {
  const db = new pg.Pool({ connectionString: databaseUrl! }); await migrate(db);
  await db.query('TRUNCATE collections CASCADE'); await db.query('TRUNCATE manifests CASCADE');
  const root = await mkdtemp(join(tmpdir(), 'sulla-files-search-')); const embedder = PotionEmbedder.load(modelDir!);
  const indexer = new IndexingQueue(db, desktopIndexSource(root), embedder); const search = new FileSearch(db, embedder); const orgId = randomUUID();
  async function collection(principalType:'user' | 'group', principalId:string) {
    const id = randomUUID(); await db.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext) VALUES($1,$2,'owner','test','knowledge','desktop-only','{}','{}')`, [id, orgId]);
    await db.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,$2,$3,'view')", [id, principalType, principalId]); return id;
  }
  async function version(collectionId:string, path:string, content:string, fileId?:string) {
    await writeFile(join(root, path), content); const id = fileId ?? randomUUID(); const versionId = randomUUID(); const manifest = randomUUID();
    await db.query("INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,'[]',$2)", [manifest, content.length]);
    if (!fileId) await db.query("INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,extraction_status) VALUES($1,$2,$3,'user','owner','text/plain',$4,'pending')", [id, collectionId, path, content.length]);
    await db.query("INSERT INTO file_versions(id,file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,device_id) VALUES($1,$2,$3,$4,$5,'user','owner','test')", [versionId, id, collectionId, manifest, content.length]);
    await db.query("UPDATE files SET current_version_id=$2,size=$3,search_text=NULL,extraction_status='pending',deleted_at=NULL WHERE id=$1", [id, versionId, content.length]);
    await indexer.flush(); return id;
  }
  const scopes = (userId:string, groups:string[] = []) => searchableScopes(db, { query: async() => ({ rows: groups.map(group_id => ({ group_id })) }) } as any, { userId, deviceId: 'test', kind: 'capability' });
  return { db, search, indexer, collection, version, scopes };
}

test('search enforces user, group, and no-grant collection ACLs', { skip: !enabled }, async() => {
  const h = await harness(); try {
    const own = await h.collection('user', 'alice'); const group = await h.collection('group', 'designers'); const denied = await h.collection('group', 'finance');
    await h.version(own, 'mine.txt', 'quarterly rebate notes'); await h.version(group, 'team.txt', 'quarterly rebate schedule'); await h.version(denied, 'secret.txt', 'quarterly rebate secret');
    const rows = await h.search.search({ query: 'quarterly rebate' }, await h.scopes('alice', ['designers']));
    assert.deepEqual(new Set(rows.map(row => row.path)), new Set(['mine.txt', 'team.txt']));
  } finally { h.indexer.close(); await h.db.end() }
});

test('trash/delete removes a file from keyword and meaning results', { skip: !enabled }, async() => {
  const h = await harness(); try {
    const collection = await h.collection('user', 'alice'); const file = await h.version(collection, 'trash.txt', 'violet warranty exception');
    assert.equal((await h.search.search({ query: 'violet warranty' }, await h.scopes('alice'))).length, 1);
    await h.db.query('UPDATE files SET deleted_at=NOW() WHERE id=$1', [file]);
    assert.equal((await h.search.search({ query: 'violet warranty' }, await h.scopes('alice'))).length, 0);
  } finally { h.indexer.close(); await h.db.end() }
});

test('a new version drops stale chunks and reindexes current content', { skip: !enabled }, async() => {
  const h = await harness(); try {
    const collection = await h.collection('user', 'alice'); const file = await h.version(collection, 'versioned.txt', 'orchard irrigation handbook');
    await h.version(collection, 'versioned.txt', 'satellite antenna calibration', file);
    assert.equal((await h.search.search({ query: 'orchard irrigation' }, await h.scopes('alice'))).length, 0);
    assert.equal((await h.search.search({ query: 'satellite antenna' }, await h.scopes('alice'))).length, 1);
  } finally { h.indexer.close(); await h.db.end() }
});
