import { createHash, randomUUID } from 'node:crypto';

import { fastCdc } from './chunking';
import { chunkId, decryptChunk, encryptChunk } from './crypto';
import { FileKeyring } from './keyring';
import { postgresClient } from '../database/PostgresClient';

import type { ChunkStore, CollectionKind, CollectionRole, ToolExecutionContext } from './types';
import type { PoolClient } from 'pg';

const ROLE_LEVEL: Record<CollectionRole, number> = { view: 1, 'use-by-agents': 2, edit: 3, manage: 4 };
const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'application/json', 'application/yaml']);

interface CollectionRow {
  id:                   string;
  kind:                 CollectionKind;
  owner_user_id:        string;
  home:                 string;
  encrypted_data_key:   any;
  dedup_key_ciphertext: any;
}

function manifestHash(ids: string[], size: number): string {
  return createHash('sha256').update(JSON.stringify({ ids, size })).digest('hex');
}

function isText(mime: string): boolean { return TEXT_MIMES.has(mime) || mime.startsWith('text/') }

export class SullaFilesService {
  constructor(private readonly store: ChunkStore, private readonly keyring: FileKeyring) {}

  async createCollection(context: ToolExecutionContext, name: string, kind: CollectionKind, agentRunId?: string): Promise<string> {
    const id = randomUUID();
    const keys = await this.keyring.create(id);
    await postgresClient.transaction(async(client) => {
      await client.query(`INSERT INTO collections
        (id, org_id, owner_user_id, agent_run_id, name, kind, home, encrypted_data_key, dedup_key_ciphertext, retention_policy)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, context.org_id ?? null, context.sub, agentRunId ?? null, name, kind,
        kind === 'knowledge' ? 'synced' : 'desktop-only', keys.encryptedDataKey, keys.encryptedDedupKey,
        kind === 'scratch' ? { ttlDaysAfterRun: 14 } : {}]);
      await client.query(`INSERT INTO collection_acl(collection_id, principal_type, principal_id, role) VALUES ($1,'user',$2,'manage')`, [id, context.sub]);
    });
    return id;
  }

  async ensureScratch(context: ToolExecutionContext): Promise<string> {
    if (!context.job_id) throw new Error('Agent scratch requires job_id');
    const row = await postgresClient.queryOne<{ id: string }>('SELECT id FROM collections WHERE agent_run_id=$1', [context.job_id]);
    return row?.id ?? this.createCollection(context, `Scratch ${ context.job_id }`, 'scratch', context.job_id);
  }

  async ensureKnowledge(context: ToolExecutionContext): Promise<string> {
    const row = await postgresClient.queryOne<{ id: string }>(`SELECT c.id FROM collections c JOIN collection_acl a ON a.collection_id=c.id
      WHERE c.kind='knowledge' AND a.principal_type='user' AND a.principal_id=$1 ORDER BY c.created_at LIMIT 1`, [context.sub]);
    return row?.id ?? this.createCollection(context, 'Knowledge', 'knowledge');
  }

  async endScratchRun(agentRunId: string, endedAt = new Date()): Promise<number> {
    const expiresAt = new Date(endedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
    const rows = await postgresClient.query<{ id: string }>(`UPDATE files f SET expires_at=$2,updated_at=NOW()
      FROM collections c WHERE f.collection_id=c.id AND c.agent_run_id=$1 AND c.kind='scratch' AND f.expires_at IS NULL AND f.deleted_at IS NULL RETURNING f.id`, [agentRunId, expiresAt]);
    return rows.length;
  }

  async keepScratchRun(context: ToolExecutionContext, agentRunId: string, targetCollectionId: string): Promise<number> {
    const target = await this.collection(context, targetCollectionId, 'edit');
    if (target.kind !== 'knowledge') throw new Error('Keep target must be a knowledge collection');
    const rows = await postgresClient.query<{ id: string }>(`UPDATE files f SET collection_id=$3,expires_at=NULL,updated_at=NOW()
      FROM collections c WHERE f.collection_id=c.id AND c.agent_run_id=$1 AND c.owner_user_id=$2 AND f.deleted_at IS NULL RETURNING f.id`, [agentRunId, context.sub, targetCollectionId]);
    return rows.length;
  }

  private async collection(context: ToolExecutionContext, id: string, required: CollectionRole): Promise<CollectionRow> {
    const collection = await postgresClient.queryOne<CollectionRow>('SELECT * FROM collections WHERE id=$1', [id]);
    if (!collection) throw new Error('Collection not found');
    if ((context.agent_id || context.job_id) && required === 'view') required = 'use-by-agents';
    const rows = await postgresClient.query<{ role: CollectionRole }>(`SELECT role FROM collection_acl
      WHERE collection_id=$1 AND principal_type='user' AND principal_id=$2`,
    [id, context.sub]);
    const actual = rows.reduce((max, row) => Math.max(max, ROLE_LEVEL[row.role]), 0);
    if (actual < ROLE_LEVEL[required]) throw new Error(`Access denied: ${ required } permission required`);
    return collection;
  }

  private async keys(collection: CollectionRow) {
    return this.keyring.unwrap(collection.id, collection.encrypted_data_key, collection.dedup_key_ciphertext);
  }

  async put(context: ToolExecutionContext, input: { collectionId?: string; path: string; bytes: Uint8Array; mime: string; message?: string; expiresAt?: Date; derivedFrom?: string[] }): Promise<any> {
    const collectionId = input.collectionId ?? (context.job_id ? await this.ensureScratch(context) : await this.ensureKnowledge(context));
    const collection = await this.collection(context, collectionId, 'edit');
    if (collection.kind === 'scratch' && !context.job_id) throw new Error('Scratch writes require an agent run');
    const { dataKey, dedupKey } = await this.keys(collection);
    const chunks = fastCdc(input.bytes);
    const ids: string[] = [];
    const stored: { id: string; size: number; storedSize: number }[] = [];
    for (const plaintext of chunks) {
      const id = chunkId(plaintext, dedupKey);
      ids.push(id);
      if (!await this.store.has(collectionId, id)) {
        const encrypted = await encryptChunk(plaintext, dataKey, id);
        await this.store.put(collectionId, { id, bytes: Buffer.from(JSON.stringify(encrypted.envelope)) });
        stored.push({ id, size: plaintext.byteLength, storedSize: encrypted.storedSize });
      }
    }
    const mHash = manifestHash(ids, input.bytes.byteLength);
    const text = isText(input.mime) && input.bytes.byteLength <= 4 * 1024 * 1024 ? Buffer.from(input.bytes).toString('utf8') : null;
    const result = await postgresClient.transaction(async(client) => this.commitPut(client, context, collection, input, mHash, ids, stored, text));
    return { ...result, collectionId, chunkCount: ids.length, newChunkCount: stored.length };
  }

  private async commitPut(client: PoolClient, context: ToolExecutionContext, collection: CollectionRow, input: any, mHash: string, ids: string[], stored: any[], text: string | null) {
    await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [mHash, JSON.stringify(ids), input.bytes.byteLength]);
    for (const chunk of stored) await client.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES ($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING`, [collection.id, chunk.id, chunk.size, chunk.storedSize, `chunks/${ collection.id }/${ chunk.id }`]);
    let file = (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE', [collection.id, input.path])).rows[0];
    const creatorType = context.job_id ? 'agent-run' : 'user';
    const expiry = collection.kind === 'scratch' ? (input.expiresAt ?? null) : null;
    if (!file) {
      file = (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,expires_at,search_text)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [collection.id, input.path, creatorType, context.job_id ?? context.sub, input.mime, input.bytes.byteLength, expiry, text])).rows[0];
    }
    const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [file.id, collection.id, file.current_version_id, mHash, input.bytes.byteLength, creatorType, context.job_id ?? context.sub, input.message ?? null, context.device_id ?? 'desktop'])).rows[0];
    await client.query('UPDATE files SET current_version_id=$2,mime=$3,size=$4,expires_at=$5,search_text=$6,deleted_at=NULL,updated_at=NOW() WHERE id=$1', [file.id, version.id, input.mime, input.bytes.byteLength, expiry, text]);
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [collection.id, ids]);
    await client.query(`INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')`, [collection.id, file.id, version.id]);
    await this.replaceEdges(client, file.id, input.path, text, creatorType, context.job_id ?? context.sub, input.derivedFrom ?? []);
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action) VALUES($1,$2,$3,$4,$5,'put')`, [creatorType, context.sub, context.job_id ?? context.device_id ?? 'desktop', file.id, version.id]);
    return { fileId: file.id, versionId: version.id, manifestHash: mHash };
  }

  private async replaceEdges(client: PoolClient, fileId: string, path: string, text: string | null, creatorType: string, creatorId: string, derivedFrom: string[]) {
    await client.query(`DELETE FROM edges WHERE src_type='file' AND src_id=$1 AND kind IN ('links_to','created_by','derived_from')`, [fileId]);
    await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES('file',$1,$2,$3,'created_by',$3) ON CONFLICT DO NOTHING`, [fileId, creatorType, creatorId]);
    for (const source of derivedFrom) await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES('file',$1,'file',$2,'derived_from',$3) ON CONFLICT DO NOTHING`, [fileId, source, creatorId]);
    if (text) {
      const links = new Set<string>();
      for (const match of text.matchAll(/\[\[([^\]]+)\]\]|\[[^\]]*\]\((?!https?:|mailto:)([^)]+)\)/g)) links.add((match[1] ?? match[2]).trim());
      for (const link of links) await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,props,created_by) VALUES('file',$1,'file-path',$2,'links_to',$3,$4) ON CONFLICT DO NOTHING`, [fileId, link, { fromPath: path }, creatorId]);
    }
  }

  async get(context: ToolExecutionContext, fileId: string, versionId?: string): Promise<{ bytes: Uint8Array; file: any; version: any }> {
    const file = await postgresClient.queryOne<any>('SELECT * FROM files WHERE id=$1', [fileId]);
    if (!file) throw new Error('File not found');
    await this.collection(context, file.collection_id, 'view');
    const version = await postgresClient.queryOne<any>('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2', [versionId ?? file.current_version_id, fileId]);
    if (!version || version.deleted) throw new Error('File version not found');
    const storageCollection = await postgresClient.queryOne<CollectionRow>('SELECT * FROM collections WHERE id=$1', [version.chunk_collection_id]);
    if (!storageCollection) throw new Error('Chunk collection not found');
    const { dataKey } = await this.keys(storageCollection);
    const manifest = await postgresClient.queryOne<any>('SELECT * FROM manifests WHERE hash=$1', [version.manifest_hash]);
    const parts: Uint8Array[] = [];
    for (const id of manifest.chunk_ids) parts.push(await decryptChunk(await this.store.get(storageCollection.id, id), dataKey, id));
    await postgresClient.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action) VALUES($1,$2,$3,$4,$5,'get')`, [context.job_id ? 'agent-run' : 'user', context.sub, context.job_id ?? context.device_id ?? 'desktop', fileId, version.id]);
    return { bytes: Buffer.concat(parts), file, version };
  }

  async list(context: ToolExecutionContext, collectionId: string, prefix = ''): Promise<any[]> {
    await this.collection(context, collectionId, 'view');
    return postgresClient.query('SELECT id,path,mime,size,expires_at,current_version_id,updated_at FROM files WHERE collection_id=$1 AND deleted_at IS NULL AND path LIKE $2 ORDER BY path', [collectionId, `${ prefix }%`]);
  }

  async history(context: ToolExecutionContext, fileId: string): Promise<any[]> {
    const file = await postgresClient.queryOne<any>('SELECT collection_id FROM files WHERE id=$1', [fileId]);
    if (!file) throw new Error('File not found');
    await this.collection(context, file.collection_id, 'view');
    return postgresClient.query('SELECT id,parent_version_id,size,deleted,created_by_type,created_by_id,created_at,message,device_id FROM file_versions WHERE file_id=$1 ORDER BY created_at DESC', [fileId]);
  }

  async restore(context: ToolExecutionContext, fileId: string, versionId: string): Promise<any> {
    const old = await this.get(context, fileId, versionId);
    return this.put(context, { collectionId: old.file.collection_id, path: old.file.path, bytes: old.bytes, mime: old.file.mime, message: `Restore ${ versionId }` });
  }

  async link(context: ToolExecutionContext, fileId: string, targetFileId: string, kind: 'links_to' | 'derived_from'): Promise<void> {
    const file = await postgresClient.queryOne<any>('SELECT collection_id FROM files WHERE id=$1', [fileId]);
    if (!file) throw new Error('File not found');
    const target = await postgresClient.queryOne<any>('SELECT collection_id FROM files WHERE id=$1 AND deleted_at IS NULL', [targetFileId]);
    if (!target) throw new Error('Target file not found');
    await this.collection(context, file.collection_id, 'edit');
    await this.collection(context, target.collection_id, 'view');
    await postgresClient.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES('file',$1,'file',$2,$3,$4) ON CONFLICT DO NOTHING`, [fileId, targetFileId, kind, context.job_id ?? context.sub]);
  }

  async search(context: ToolExecutionContext, collectionId: string, query: string): Promise<any[]> {
    await this.collection(context, collectionId, 'view');
    return postgresClient.query(`SELECT id,path,mime,size,updated_at,ts_rank(search_vector, plainto_tsquery('simple',$2)) rank FROM files
      WHERE collection_id=$1 AND deleted_at IS NULL AND search_vector @@ plainto_tsquery('simple',$2) ORDER BY rank DESC, path LIMIT 100`, [collectionId, query]);
  }

  async promote(context: ToolExecutionContext, fileId: string, targetCollectionId: string, path?: string): Promise<void> {
    const file = await postgresClient.queryOne<any>('SELECT * FROM files WHERE id=$1', [fileId]);
    if (!file) throw new Error('File not found');
    const source = await this.collection(context, file.collection_id, 'edit');
    if (source.kind !== 'scratch') throw new Error('Only scratch files can be promoted');
    const target = await this.collection(context, targetCollectionId, 'edit');
    if (target.kind !== 'knowledge') throw new Error('Promotion target must be knowledge');
    await postgresClient.transaction(async(client) => {
      await client.query('UPDATE files SET collection_id=$2,path=$3,expires_at=NULL,updated_at=NOW() WHERE id=$1', [fileId, targetCollectionId, path ?? file.path]);
      await client.query(`INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'promote')`, [targetCollectionId, fileId, file.current_version_id]);
      await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action) VALUES($1,$2,$3,$4,$5,'promote')`, [context.job_id ? 'agent-run' : 'user', context.sub, context.job_id ?? context.device_id ?? 'desktop', fileId, file.current_version_id]);
    });
  }

  async expireAndGc(now = new Date()): Promise<{ expiredFiles: number; deletedChunks: number }> {
    const expired = await postgresClient.transaction(async(client) => {
      const rows = (await client.query<any>('SELECT * FROM files WHERE expires_at<$1 AND deleted_at IS NULL FOR UPDATE', [now])).rows;
      for (const file of rows) {
        const deleted = (await client.query<any>(`INSERT INTO file_versions
          (file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id)
          VALUES($1,$2,$3,NULL,0,TRUE,'agent-run','scratch-maintenance','Scratch TTL expired','scratch-maintenance') RETURNING id`,
        [file.id, file.collection_id, file.current_version_id])).rows[0];
        await client.query('UPDATE files SET current_version_id=$2,deleted_at=$3,updated_at=$3 WHERE id=$1', [file.id, deleted.id, now]);
        await client.query(`INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')`, [file.collection_id, file.id, deleted.id]);
      }
      return rows;
    });
    await postgresClient.query(`UPDATE chunks c SET refcount=q.refs FROM (
      SELECT v.chunk_collection_id collection_id, ids.chunk_id, count(*) refs FROM files f JOIN file_versions v ON v.file_id=f.id
      JOIN manifests m ON m.hash=v.manifest_hash CROSS JOIN jsonb_array_elements_text(m.chunk_ids) AS ids(chunk_id)
      WHERE f.deleted_at IS NULL AND v.deleted=FALSE GROUP BY v.chunk_collection_id, ids.chunk_id
    ) q WHERE c.collection_id=q.collection_id AND c.id=q.chunk_id`);
    await postgresClient.query(`UPDATE chunks c SET refcount=0 WHERE NOT EXISTS (
      SELECT 1 FROM files f JOIN file_versions v ON v.file_id=f.id JOIN manifests m ON m.hash=v.manifest_hash
      CROSS JOIN jsonb_array_elements_text(m.chunk_ids) AS ids(chunk_id)
      WHERE f.deleted_at IS NULL AND v.deleted=FALSE AND v.chunk_collection_id=c.collection_id AND ids.chunk_id=c.id)`);
    const dead = await postgresClient.query<any>('DELETE FROM chunks WHERE refcount=0 RETURNING collection_id,id');
    for (const chunk of dead) await this.store.delete(chunk.collection_id, chunk.id);
    return { expiredFiles: expired.length, deletedChunks: dead.length };
  }
}
