import express from 'express';

import { accessibleCollectionIds, requireCollectionAccess } from './acl.js';
import { verifyCapabilityToken } from './auth.js';
import { Store } from './store.js';

import type { Config } from './config.js';
import type { IndexingQueue } from './indexing.js';
import type { LocalFilesManager } from './localManager.js';
import type { FileSearch } from './search.js';
import type pg from 'pg';

export function createApp(db:pg.Pool, config:Config, manager?:LocalFilesManager, search?:FileSearch, indexer?:IndexingQueue) {
  const app = express(); const store = new Store(config.chunkRoot);
  app.use(express.json({ limit: '16mb' }));
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    if (req.path.startsWith('/v1/local/')) {
      if (!config.localToken || req.header('x-sulla-files-token') !== config.localToken) return res.status(401).json({ error: 'unauthorized local request' });
      return next();
    }
    try {
      const authorization = req.header('authorization');
      (req as any).capability = verifyCapabilityToken(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined, config.capabilitySigningKey);
      next();
    } catch { res.status(401).json({ error: 'unauthorized' }) }
  });
  const ctx = (request:any) => ({ user: request.capability?.sub || '', device: request.capability?.device_id || '' });
  async function access(request:any, collectionId:string, role:string) {
    const identity = ctx(request); if (!identity.user) throw Object.assign(new Error('identity required'), { status: 401 });
    await requireCollectionAccess(db, request.capability, collectionId, role);
    return identity;
  }
  app.get('/healthz', (_request, response) => response.json({ ok: true, mode: config.mode }));
  app.get('/v1/local/status', (_request, response) => response.json(manager ? manager.status() : { state: 'error', pendingFiles: 0, lastError: 'watched folder disabled', serverConfigured: false }));
  app.post('/v1/local/rescan', (_request, response) => { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); manager.rescan().catch(error => console.error('[SullaFiles] rescan failed', error)); response.status(202).json({ accepted: true }) });
  app.post('/v1/local/pause', async(request, response, next) => { try { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); response.json(await manager.setPaused(Boolean(request.body.paused))) } catch (error) { next(error) } });
  app.post('/v1/local/sync', (_request, response) => { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); manager.sync().catch(error => console.error('[SullaFiles] sync failed', error)); response.status(202).json({ accepted: true }) });
  app.post('/v1/search', async(request, response, next) => {
    try {
      if (!search) return response.status(503).json({ error: 'search unavailable' });
      response.json(await search.search((request as any).capability, request.body));
    } catch (error) { next(error) }
  });
  app.get('/v1/collections', async(request, response, next) => { try { const identity = ctx(request); if (!identity.user) return response.status(401).json({ error: 'identity required' }); const ids = await accessibleCollectionIds(db, (request as any).capability, 'view'); const rows = await db.query(`SELECT * FROM collections WHERE kind='knowledge' AND id=ANY($1::uuid[])`, [ids]); response.json(rows.rows) } catch (error) { next(error) } });
  app.post('/v1/collections', async(request, response, next) => {
    try {
      const identity = ctx(request); const collection = request.body.collection; if (collection.kind !== 'knowledge') return response.status(400).json({ error: 'only knowledge syncs' });
      const created = await db.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy) VALUES($1,$2,$3,$4,'knowledge','synced','org-readable',$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`, [collection.id, collection.org_id, identity.user, collection.name, collection.encrypted_data_key, collection.dedup_key_ciphertext, collection.retention_policy ?? {}]);
      if (!created.rowCount) { const acl = await db.query("SELECT role FROM collection_acl WHERE collection_id=$1 AND principal_type='user' AND principal_id=$2", [collection.id, identity.user]); if (!acl.rows.some((value:any) => value.role === 'manage')) return response.status(409).json({ error: 'collection already exists' }); } else await db.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage')", [collection.id, identity.user]); response.json({ ok: true });
    } catch (error) { next(error) }
  });
  app.get('/v1/collections/:id/journal', async(request, response, next) => { try { await access(request, request.params.id, 'view'); const query = await db.query(`SELECT j.*,row_to_json(f.*) file,row_to_json(v.*) version,row_to_json(m.*) manifest FROM journal j JOIN files f ON f.id=j.file_id JOIN file_versions v ON v.id=j.version_id LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE j.collection_id=$1 AND j.seq>$2 ORDER BY j.seq LIMIT 1000`, [request.params.id, Number(request.query.after ?? 0)]); response.json(query.rows) } catch (error) { next(error) } });
  app.get('/v1/versions/:id', async(request, response, next) => { try { const query = await db.query(`SELECT row_to_json(v.*) version,row_to_json(m.*) manifest,row_to_json(f.*) file FROM file_versions v JOIN files f ON f.id=v.file_id LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1`, [request.params.id]); if (!query.rows[0]) return response.sendStatus(404); await access(request, query.rows[0].file.collection_id, 'view'); response.json(query.rows[0]) } catch (error) { next(error) } });
  app.head('/v1/chunks/:collection/:id', async(request, response, next) => { try { await access(request, request.params.collection, 'view'); response.sendStatus(await store.has(request.params.collection, request.params.id) ? 204 : 404) } catch (error) { next(error) } });
  app.get('/v1/chunks/:collection/:id', async(request, response, next) => { try { await access(request, request.params.collection, 'view'); response.type('application/octet-stream').send(await store.get(request.params.collection, request.params.id)) } catch (error) { next(error) } });
  app.put('/v1/chunks/:collection/:id', express.raw({ type: 'application/octet-stream', limit: '8mb' }), async(request, response, next) => { try { await access(request, request.params.collection, 'edit'); await store.put(request.params.collection, request.params.id, request.body); response.sendStatus(204) } catch (error) { next(error) } });
  async function prepare(request:any, bundle:any) {
    await access(request, bundle.collectionId, 'edit');
    if (bundle.version.chunk_collection_id !== bundle.collectionId) await access(request, bundle.version.chunk_collection_id, 'edit');
    const existing = (await db.query('SELECT id,collection_id,current_version_id FROM files WHERE id=$1 OR (collection_id=$2 AND path=$3) ORDER BY id=$1 DESC LIMIT 1', [bundle.file.id, bundle.collectionId, bundle.file.path])).rows[0];
    if (existing && existing.collection_id !== bundle.collectionId) throw Object.assign(new Error('file belongs to another collection'), { status: 403 });
    const missing:string[] = []; for (const id of bundle.manifest?.chunk_ids ?? []) if (!await store.has(bundle.version.chunk_collection_id, id)) missing.push(id);
    const base = bundle.baseServerVersionId ?? null; const conflict = Boolean(existing?.current_version_id && existing.current_version_id !== base && (base || existing.id !== bundle.file.id));
    return { existing, missing, conflict, currentVersionId: existing?.current_version_id ?? null, canonicalFileId: existing?.id ?? bundle.file.id };
  }
  app.post('/v1/versions/prepare', async(request, response, next) => { try { const result = await prepare(request, request.body); response.json({ missing: result.missing, currentVersionId: result.currentVersionId, canonicalFileId: result.canonicalFileId, conflict: result.conflict }) } catch (error) { next(error) } });
  app.post('/v1/versions/commit', async(request, response, next) => {
    const client = await db.connect(); try {
      const bundle = request.body; const identity = await access(request, bundle.collectionId, 'edit'); const checked = await prepare(request, bundle); if (checked.missing.length) return response.status(400).json({ error: 'manifest chunks missing', missing: checked.missing }); if (checked.conflict) return response.status(409).json({ conflict: true, currentVersionId: checked.currentVersionId });
      const fileId = checked.canonicalFileId; await client.query('BEGIN');
      if (bundle.manifest) await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [bundle.manifest.hash, JSON.stringify(bundle.manifest.chunk_ids), bundle.manifest.total_size]);
      for (const chunk of bundle.chunks ?? []) await client.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(collection_id,id) DO UPDATE SET refcount=chunks.refcount+1', [bundle.version.chunk_collection_id, chunk.id, chunk.size, chunk.stored_size, chunk.location]);
      await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,extraction_status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,mime=EXCLUDED.mime,size=EXCLUDED.size,search_text=NULL,extracted_at=NULL,extraction_status='pending',deleted_at=$8,updated_at=NOW()`, [fileId, bundle.collectionId, bundle.file.path, bundle.file.created_by_type, bundle.file.created_by_id, bundle.file.mime, bundle.file.size, bundle.version.deleted ? new Date() : null]);
      await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`, [bundle.version.id, fileId, bundle.version.chunk_collection_id, checked.currentVersionId, bundle.manifest?.hash ?? null, bundle.version.size, bundle.version.deleted, bundle.version.created_by_type, bundle.version.created_by_id, bundle.version.message, identity.device, checked.currentVersionId]);
      await client.query('UPDATE files SET current_version_id=$2,deleted_at=$3 WHERE id=$1', [fileId, bundle.version.id, bundle.version.deleted ? new Date() : null]);
      await client.query('DELETE FROM file_search_chunks WHERE file_id=$1', [fileId]); await client.query('DELETE FROM file_index_jobs WHERE file_id=$1', [fileId]);
      if (!bundle.version.deleted) await client.query("INSERT INTO file_index_jobs(file_id,version_id,status) VALUES($1,$2,'pending')", [fileId, bundle.version.id]);
      await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [bundle.collectionId, fileId, bundle.version.id, bundle.version.deleted ? 'delete' : 'put']); await client.query('COMMIT'); indexer?.wake(); response.json({ ok: true, versionId: bundle.version.id, fileId });
    } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() }
  });
  app.use((error:any, _request:any, response:any, _next:any) => response.status(error.status ?? 500).json({ error: error.message ?? 'server error' }));
  return app;
}
