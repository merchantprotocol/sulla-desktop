import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { chunkId, decrypt, decryptChunk, encrypt, encryptChunk, type Envelope } from './crypto.js';
import { Store } from './store.js';

import type pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHUNK = /^[0-9a-f]{64}$/;
const MASTER_CONTEXT = 'sulla:files:master-check:v1';
const MASTER_CHECK = Buffer.from('sulla-files-keychain-master-v1');
const MAX_ENCRYPTED_CHUNK = 32 * 1024 * 1024;

interface Keys { data: Buffer; dedup: Buffer }
interface SourceCollection { id: string; encrypted_data_key: Envelope; dedup_key_ciphertext: Envelope; compatibility_state: string }
interface ConvertedManifest { hash: string; ids: string[]; totalSize: number; plaintextHash: string; chunks: Map<string, { size: number; storedSize: number }> }

function validId(value:string, expression:RegExp, label:string):string {
  if (!expression.test(value)) throw new Error(`Invalid legacy ${ label } identity`);
  return value.toLowerCase();
}

async function requireDirectory(path:string):Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Legacy Files import rejected a linked or non-directory path');
}

/** Reads only the exact retired UUID/bucket/hash address and never follows links. */
export async function readLegacyChunk(root:string, collectionId:string, id:string):Promise<Buffer> {
  const collection = validId(collectionId, UUID, 'collection');
  const chunk = validId(id, CHUNK, 'chunk');
  await requireDirectory(root);
  const collectionRoot = join(root, collection); const bucketRoot = join(collectionRoot, chunk.slice(0, 2));
  await requireDirectory(collectionRoot); await requireDirectory(bucketRoot);
  const file = await open(join(bucketRoot, chunk), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ENCRYPTED_CHUNK) throw new Error('Legacy Files chunk has an invalid stored size');
    return await file.readFile();
  } finally { await file.close() }
}

export async function convertLegacyManifest(input:{
  collectionId: string; chunkIds: string[]; totalSize: number; sourceRoot: string; sourceKeys: Keys; shadowKeys: Keys; store: Store; shadowCollectionId: string;
}):Promise<ConvertedManifest> {
  if (!Number.isSafeInteger(input.totalSize) || input.totalSize < 0) throw new Error('Legacy Files manifest has an invalid size');
  const outputIds:string[] = []; const chunks = new Map<string, { size: number; storedSize: number }>(); const whole = createHash('sha256'); let total = 0;
  for (const rawId of input.chunkIds) {
    const sourceId = validId(String(rawId), CHUNK, 'chunk');
    const encrypted = await readLegacyChunk(input.sourceRoot, input.collectionId, sourceId);
    const plain = Buffer.from(await decryptChunk(encrypted, input.sourceKeys.data, sourceId));
    try {
      const expected = Buffer.from(sourceId, 'hex'); const actual = Buffer.from(chunkId(plain, input.sourceKeys.dedup), 'hex');
      if (!timingSafeEqual(expected, actual)) throw new Error('Legacy Files chunk identity verification failed');
      total += plain.length; if (!Number.isSafeInteger(total) || total > input.totalSize) throw new Error('Legacy Files manifest size verification failed');
      whole.update(plain);
      const outputId = chunkId(plain, input.shadowKeys.dedup); outputIds.push(outputId);
      if (!await input.store.has(input.shadowCollectionId, outputId)) await input.store.put(input.shadowCollectionId, outputId, await encryptChunk(plain, input.shadowKeys.data, outputId));
      const stored = await input.store.get(input.shadowCollectionId, outputId);
      const verified = Buffer.from(await decryptChunk(stored, input.shadowKeys.data, outputId));
      try {
        if (!timingSafeEqual(plain, verified) || chunkId(verified, input.shadowKeys.dedup) !== outputId) throw new Error('Native shadow chunk verification failed');
        chunks.set(outputId, { size: verified.length, storedSize: stored.length });
      } finally { verified.fill(0) }
    } finally { plain.fill(0); encrypted.fill(0) }
  }
  if (total !== input.totalSize) throw new Error('Legacy Files manifest size verification failed');
  const hash = createHash('sha256').update(JSON.stringify({ ids: outputIds, size: total })).digest('hex');
  return { hash, ids: outputIds, totalSize: total, plaintextHash: whole.digest('hex'), chunks };
}

async function unwrap(envelope:Envelope, key:Buffer, context:string):Promise<Buffer> {
  const value = Buffer.from(await decrypt(envelope, key, context));
  if (value.length !== 32) { value.fill(0); throw new Error('Invalid legacy collection key') }
  return value;
}

async function sourceKeys(collection:SourceCollection, nativeMaster:Buffer, legacyMasters:Buffer[], nativeRow?:{ data_key: Envelope; dedup_key: Envelope }):Promise<Keys> {
  if (collection.compatibility_state === 'native') {
    if (!nativeRow) throw new Error('Native source collection key is unavailable');
    const data = await unwrap(nativeRow.data_key, nativeMaster, `sulla:files:data-key:v1:${ collection.id }`);
    try { return { data, dedup: await unwrap(nativeRow.dedup_key, nativeMaster, `sulla:files:dedup-key:v1:${ collection.id }`) } } catch (error) { data.fill(0); throw error }
  }
  const matches:Keys[] = [];
  for (const master of legacyMasters) {
    try {
      const data = await unwrap(collection.encrypted_data_key, master, `sulla:files:data-key:v1:${ collection.id }`);
      try { matches.push({ data, dedup: await unwrap(collection.dedup_key_ciphertext, master, `sulla:files:dedup-key:v1:${ collection.id }`) }) } catch { data.fill(0) }
    } catch { /* A candidate may belong to another retired store. */ }
  }
  const unique = matches.filter((candidate, index) => matches.findIndex(other => timingSafeEqual(candidate.data, other.data) && timingSafeEqual(candidate.dedup, other.dedup)) === index);
  for (const candidate of matches) if (!unique.includes(candidate)) { candidate.data.fill(0); candidate.dedup.fill(0) }
  if (unique.length !== 1) { for (const candidate of unique) { candidate.data.fill(0); candidate.dedup.fill(0) } throw new Error('Legacy Files collection key authentication failed') }
  return unique[0];
}

async function verifyNativeMaster(client:pg.PoolClient, master:Buffer):Promise<void> {
  if (master.length !== 32) throw new Error('Invalid Files master key');
  const row = (await client.query('SELECT verifier FROM files_key_state WHERE id=TRUE FOR UPDATE')).rows[0];
  if (!row) return;
  const check = Buffer.from(await decrypt(row.verifier, master, MASTER_CONTEXT));
  try { if (check.length !== MASTER_CHECK.length || !timingSafeEqual(check, MASTER_CHECK)) throw new Error('Invalid Files master key'); } finally { check.fill(0) }
}

async function legacyLayoutIds(root:string):Promise<string[]> {
  await requireDirectory(root); const ids:string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const collectionRoot = join(root, entry.name); await requireDirectory(collectionRoot); let found = false;
    for (const bucket of await readdir(collectionRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory() || !/^[a-f0-9]{2}$/i.test(bucket.name)) continue;
      const bucketRoot = join(collectionRoot, bucket.name); await requireDirectory(bucketRoot);
      if ((await readdir(bucketRoot, { withFileTypes: true })).some(chunk => chunk.isFile() && CHUNK.test(chunk.name))) { found = true; break }
    }
    if (found) ids.push(entry.name.toLowerCase());
  }
  return ids.sort();
}

export class LegacyFilesImporter {
  private readonly store: Store;
  constructor(private readonly db:pg.Pool, private readonly sourceRoot:string, chunkRoot:string) { this.store = new Store(chunkRoot) }

  async run(nativeMaster:Buffer, suppliedLegacyMasters:Buffer[]):Promise<{ collections: number; files: number; versions: number }> {
    if (nativeMaster.length !== 32 || suppliedLegacyMasters.some(key => key.length !== 32) || suppliedLegacyMasters.length === 0) throw new Error('Invalid Files import key material');
    const legacyMasters = suppliedLegacyMasters.map(value => Buffer.from(value));
    try {
      const staged = await this.stage(nativeMaster);
      const layout = await legacyLayoutIds(this.sourceRoot);
      const externalIds = staged.collections.filter(row => row.compatibility_state !== 'native').map(row => row.id).sort();
      if (layout.some(id => !externalIds.includes(id))) throw new Error('Legacy Files chunk collection has no authenticated metadata');
      const converted = new Map<string, ConvertedManifest>(); const collectionKeys = new Map<string, Keys>();
      try {
        for (const collection of staged.collections) {
          const nativeRow = (await this.db.query('SELECT data_key,dedup_key FROM files_collection_keys WHERE collection_id=$1', [collection.id])).rows[0];
          collectionKeys.set(collection.id, await sourceKeys(collection, nativeMaster, legacyMasters, nativeRow));
        }
        const shadowKeys = new Map<string, Keys>();
        try {
          for (const mapping of staged.mappings) {
            const row = (await this.db.query('SELECT data_key,dedup_key FROM files_collection_keys WHERE collection_id=$1', [mapping.shadow_collection_id])).rows[0];
            shadowKeys.set(mapping.source_collection_id, {
              data:  await unwrap(row.data_key, nativeMaster, `sulla:files:data-key:v1:${ mapping.shadow_collection_id }`),
              dedup: await unwrap(row.dedup_key, nativeMaster, `sulla:files:dedup-key:v1:${ mapping.shadow_collection_id }`),
            });
          }
          const versions = (await this.db.query(`SELECT v.*,m.chunk_ids,m.total_size FROM file_versions v JOIN files f ON f.id=v.file_id
            LEFT JOIN manifests m ON m.hash=v.manifest_hash JOIN files_legacy_file_map fm ON fm.source_file_id=f.id ORDER BY v.created_at,v.id`)).rows;
          for (const version of versions) {
            if (version.deleted || !version.manifest_hash) continue;
            const key = `${ version.chunk_collection_id }:${ version.manifest_hash }`;
            if (!converted.has(key)) {
              const source = collectionKeys.get(version.chunk_collection_id); const shadow = shadowKeys.get(version.chunk_collection_id);
              const mapping = staged.mappings.find(row => row.source_collection_id === version.chunk_collection_id);
              if (!source || !shadow || !mapping) throw new Error('Legacy Files version references an unmapped chunk collection');
              const item = await convertLegacyManifest({ collectionId: version.chunk_collection_id, chunkIds: version.chunk_ids, totalSize: Number(version.total_size), sourceRoot: this.sourceRoot, sourceKeys: source, shadowKeys: shadow, store: this.store, shadowCollectionId: mapping.shadow_collection_id });
              if (item.totalSize !== Number(version.size)) throw new Error('Legacy Files version size verification failed');
              converted.set(key, item);
            }
          }
          return await this.publish(nativeMaster, staged, versions, converted);
        } finally {
          for (const keys of shadowKeys.values()) { keys.data.fill(0); keys.dedup.fill(0) }
        }
      } finally {
        for (const keys of collectionKeys.values()) { keys.data.fill(0); keys.dedup.fill(0) }
      }
    } finally { for (const key of legacyMasters) key.fill(0); }
  }

  private async stage(nativeMaster:Buffer):Promise<{ collections: SourceCollection[]; mappings: any[] }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sulla-files-legacy-import']); await verifyNativeMaster(client, nativeMaster);
      let expanded:number | null = 1;
      while (expanded) {
        const result = await client.query(`UPDATE collections c SET legacy_source=TRUE WHERE c.legacy_source=FALSE AND (
          EXISTS (SELECT 1 FROM files f JOIN file_versions v ON v.file_id=f.id JOIN collections chunks ON chunks.id=v.chunk_collection_id WHERE f.collection_id=c.id AND chunks.legacy_source=TRUE)
          OR EXISTS (SELECT 1 FROM file_versions v JOIN files f ON f.id=v.file_id JOIN collections owner ON owner.id=f.collection_id WHERE v.chunk_collection_id=c.id AND owner.legacy_source=TRUE))`);
        expanded = result.rowCount;
      }
      const collections = (await client.query<SourceCollection>('SELECT id::text,encrypted_data_key,dedup_key_ciphertext,compatibility_state FROM collections WHERE legacy_source=TRUE ORDER BY id FOR UPDATE')).rows;
      if (!collections.length) throw new Error('No legacy Files collections require import');
      await client.query(`INSERT INTO files_protected_files(file_id) SELECT f.id FROM files f JOIN collections c ON c.id=f.collection_id WHERE c.legacy_source=TRUE ON CONFLICT DO NOTHING`);
      await client.query("INSERT INTO files_legacy_imports(id,state) VALUES(TRUE,'staging') ON CONFLICT(id) DO UPDATE SET state=CASE WHEN files_legacy_imports.state='completed' THEN files_legacy_imports.state ELSE 'staging' END");
      for (const source of collections) {
        const mapping = (await client.query('SELECT * FROM files_legacy_collection_map WHERE source_collection_id=$1', [source.id])).rows[0];
        if (!mapping) {
          const id = randomUUID(); const data = randomBytes(32); const dedup = randomBytes(32);
          try {
            const wrappedData = await encrypt(data, nativeMaster, `sulla:files:data-key:v1:${ id }`); const wrappedDedup = await encrypt(dedup, nativeMaster, `sulla:files:dedup-key:v1:${ id }`);
            await client.query(`INSERT INTO collections(id,org_id,owner_user_id,agent_run_id,thread_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy,created_at,updated_at,compatibility_state,legacy_source,published)
              SELECT $2,org_id,owner_user_id,agent_run_id,thread_id,name,kind,home,encryption,$3,$4,retention_policy,created_at,updated_at,'native',FALSE,FALSE FROM collections WHERE id=$1`, [source.id, id, wrappedData, wrappedDedup]);
            await client.query("INSERT INTO files_collection_keys(collection_id,data_key,dedup_key,key_origin) VALUES($1,$2,$3,'random')", [id, wrappedData, wrappedDedup]);
            await client.query('INSERT INTO files_legacy_collection_map(source_collection_id,shadow_collection_id) VALUES($1,$2)', [source.id, id]);
          } finally { data.fill(0); dedup.fill(0) }
        }
      }
      const mappings = (await client.query('SELECT source_collection_id::text,shadow_collection_id::text,published_at FROM files_legacy_collection_map ORDER BY source_collection_id')).rows;
      await client.query(`INSERT INTO files_legacy_file_map(source_file_id,shadow_file_id,source_collection_id,shadow_collection_id)
        SELECT f.id,gen_random_uuid(),f.collection_id,m.shadow_collection_id FROM files f JOIN files_legacy_collection_map m ON m.source_collection_id=f.collection_id ON CONFLICT(source_file_id) DO NOTHING`);
      await client.query(`INSERT INTO files_legacy_version_map(source_version_id,shadow_version_id)
        SELECT v.id,gen_random_uuid() FROM file_versions v JOIN files_legacy_file_map f ON f.source_file_id=v.file_id ON CONFLICT(source_version_id) DO NOTHING`);
      await client.query('COMMIT'); return { collections, mappings };
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  private async publish(nativeMaster:Buffer, staged:{ collections: SourceCollection[]; mappings: any[] }, versions:any[], converted:Map<string, ConvertedManifest>):Promise<{ collections: number; files: number; versions: number }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['sulla-files-legacy-import']); await verifyNativeMaster(client, nativeMaster);
      for (const [key, manifest] of converted) {
        const sourceCollection = key.slice(0, key.indexOf(':')); const mapping = staged.mappings.find(row => row.source_collection_id === sourceCollection)!;
        await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT(hash) DO UPDATE SET chunk_ids=EXCLUDED.chunk_ids,total_size=EXCLUDED.total_size', [manifest.hash, JSON.stringify(manifest.ids), manifest.totalSize]);
        for (const [id, chunk] of manifest.chunks) {
          await client.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,0)
          ON CONFLICT(collection_id,id) DO UPDATE SET size=EXCLUDED.size,stored_size=EXCLUDED.stored_size,location=EXCLUDED.location`, [mapping.shadow_collection_id, id, chunk.size, chunk.storedSize, `chunks/${ mapping.shadow_collection_id }/${ id }`]);
        }
      }
      await client.query(`INSERT INTO files(id,collection_id,path,deleted_at,expires_at,created_by_type,created_by_id,mime,size,search_text,created_at,updated_at,extracted_at,extraction_status,person_id)
        SELECT fm.shadow_file_id,fm.shadow_collection_id,f.path,f.deleted_at,f.expires_at,f.created_by_type,f.created_by_id,f.mime,f.size,f.search_text,f.created_at,f.updated_at,f.extracted_at,f.extraction_status,f.person_id
        FROM files f JOIN files_legacy_file_map fm ON fm.source_file_id=f.id ON CONFLICT(id) DO NOTHING`);
      const versionMap = new Map((await client.query('SELECT source_version_id::text,shadow_version_id::text FROM files_legacy_version_map')).rows.map(row => [row.source_version_id, row.shadow_version_id]));
      const fileMap = new Map((await client.query('SELECT source_file_id::text,shadow_file_id::text FROM files_legacy_file_map')).rows.map(row => [row.source_file_id, row.shadow_file_id]));
      for (const version of versions) {
        const manifest = version.manifest_hash ? converted.get(`${ version.chunk_collection_id }:${ version.manifest_hash }`) : undefined;
        const collection = staged.mappings.find(row => row.source_collection_id === version.chunk_collection_id);
        if (!collection) throw new Error('Legacy Files version references an unmapped chunk collection');
        await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,created_at,message,device_id,base_server_version_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`, [versionMap.get(version.id), fileMap.get(version.file_id), collection.shadow_collection_id, version.parent_version_id ? versionMap.get(version.parent_version_id) : null, manifest?.hash ?? null, version.size, version.deleted, version.created_by_type, version.created_by_id, version.created_at, version.message, version.device_id, version.base_server_version_id ? versionMap.get(version.base_server_version_id) ?? null : null]);
        if (manifest) await client.query('UPDATE files_legacy_version_map SET shadow_manifest_hash=$2,plaintext_sha256=$3,verified_at=NOW() WHERE source_version_id=$1', [version.id, manifest.hash, manifest.plaintextHash]);
      }
      await client.query(`UPDATE files shadow SET current_version_id=vm.shadow_version_id FROM files source
        JOIN files_legacy_file_map fm ON fm.source_file_id=source.id JOIN files_legacy_version_map vm ON vm.source_version_id=source.current_version_id
        WHERE shadow.id=fm.shadow_file_id`);
      await client.query(`INSERT INTO collection_acl(collection_id,principal_type,principal_id,role,created_at)
        SELECT m.shadow_collection_id,a.principal_type,a.principal_id,a.role,a.created_at FROM collection_acl a JOIN files_legacy_collection_map m ON m.source_collection_id=a.collection_id ON CONFLICT DO NOTHING`);
      await client.query(`INSERT INTO folder_shares(collection_id,folder_path,principal_type,principal_id,role,created_by,created_at,updated_at)
        SELECT m.shadow_collection_id,s.folder_path,s.principal_type,s.principal_id,s.role,s.created_by,s.created_at,s.updated_at FROM folder_shares s JOIN files_legacy_collection_map m ON m.source_collection_id=s.collection_id ON CONFLICT DO NOTHING`);
      await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,props,created_by,created_at)
        SELECT e.src_type,COALESCE(src.shadow_file_id::text,e.src_id),e.dst_type,COALESCE(dst.shadow_file_id::text,e.dst_id),e.kind,e.props,e.created_by,e.created_at FROM edges e
        JOIN files_legacy_file_map src ON e.src_type='file' AND src.source_file_id::text=e.src_id LEFT JOIN files_legacy_file_map dst ON e.dst_type='file' AND dst.source_file_id::text=e.dst_id ON CONFLICT DO NOTHING`);
      await client.query(`INSERT INTO journal(collection_id,file_id,version_id,op,at)
        SELECT cm.shadow_collection_id,fm.shadow_file_id,vm.shadow_version_id,j.op,j.at FROM journal j JOIN files_legacy_collection_map cm ON cm.source_collection_id=j.collection_id JOIN files_legacy_file_map fm ON fm.source_file_id=j.file_id JOIN files_legacy_version_map vm ON vm.source_version_id=j.version_id
        WHERE NOT EXISTS(SELECT 1 FROM journal existing WHERE existing.collection_id=cm.shadow_collection_id AND existing.file_id=fm.shadow_file_id AND existing.version_id=vm.shadow_version_id AND existing.op=j.op AND existing.at=j.at)`);
      await client.query(`UPDATE chunks c SET refcount=q.refs FROM (SELECT v.chunk_collection_id collection_id,x.id,count(*) refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash CROSS JOIN LATERAL jsonb_array_elements_text(m.chunk_ids) x(id)
        JOIN files_legacy_version_map vm ON vm.shadow_version_id=v.id GROUP BY v.chunk_collection_id,x.id) q WHERE c.collection_id=q.collection_id AND c.id=q.id`);
      const unverified = await client.query(`SELECT 1 FROM files_legacy_version_map vm JOIN file_versions v ON v.id=vm.source_version_id WHERE v.deleted=FALSE AND v.manifest_hash IS NOT NULL AND vm.verified_at IS NULL LIMIT 1`);
      if (unverified.rowCount) throw new Error('Legacy Files import verification is incomplete');
      await client.query('UPDATE collections SET published=TRUE WHERE id IN(SELECT shadow_collection_id FROM files_legacy_collection_map)');
      await client.query('UPDATE files_legacy_collection_map SET published_at=COALESCE(published_at,NOW())');
      await client.query("UPDATE files_legacy_imports SET state='completed',completed_at=COALESCE(completed_at,NOW()) WHERE id=TRUE");
      await client.query("UPDATE files_legacy_preflight SET state='clear',reason='retired-external-chunk-store-converted',checked_at=NOW() WHERE id=TRUE");
      if (!(await client.query('SELECT 1 FROM files_key_state WHERE id=TRUE')).rowCount) await client.query('INSERT INTO files_key_state(id,verifier) VALUES(TRUE,$1)', [await encrypt(MASTER_CHECK, nativeMaster, MASTER_CONTEXT)]);
      await client.query('COMMIT');
      return { collections: staged.mappings.length, files: fileMap.size, versions: versionMap.size };
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
}
