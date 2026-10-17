import { createHash, randomUUID } from 'node:crypto';

import express from 'express';

import { resolveCollectionGrants, ROLE_LEVEL, searchableScopes } from './acl.js';
import { verifyFilesIdentity, type FilesIdentity } from './auth.js';
import { chunkId, encryptChunk } from './crypto.js';
import { runLegacyPreflight } from './legacyPreflight.js';
import { assertUnprotectedFile, isProtectedPath, protectedPathError } from './protectedFiles.js';
import { loadFileContent, thumbnail } from './preview.js';
import { SharesService } from './shares.js';
import { Store } from './store.js';

import type { Config } from './config.js';
import type { LocalFilesManager } from './localManager.js';
import type { FileSearch } from './search.js';
import type pg from 'pg';

const CHUNK_BYTES = 4 * 1024 * 1024;
type RequestWithIdentity = express.Request<Record<string, string>> & { filesIdentity?: FilesIdentity };
type Right = 'view' | 'use-by-agents' | 'edit' | 'manage';

class HttpError extends Error { constructor(public readonly status:number, message:string) { super(message) } }

function cleanPath(value:unknown, allowEmpty = true):string {
  if (typeof value !== 'string') throw new HttpError(400, 'path must be a string');
  const path = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!path && allowEmpty) return '';
  if ((!allowEmpty && !path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new HttpError(400, 'invalid Files path');
  return path;
}
function bearer(request:express.Request):string | undefined { return request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] }

export function createApp(db:pg.Pool, config:Config, manager?:LocalFilesManager, identityDb?:pg.Pool, search?:FileSearch, onUnlock?:()=>Promise<void>, onLock?:()=>Promise<void>) {
  const app = express(); const store = new Store(config.chunkRoot); const shares = new SharesService(db, config, store); const jsonParser = express.json({ limit: '20mb' });
  let lifecycle:Promise<unknown> = Promise.resolve();
  let ready = Boolean(config.keyring?.unlocked);
  const serial = <T>(operation:()=>Promise<T>):Promise<T> => { const result = lifecycle.then(operation); lifecycle = result.catch(() => undefined); return result; };
  app.disable('x-powered-by'); app.use((request, response, next) => request.path === '/v1/files/upload' ? next() : jsonParser(request, response, next));
  app.use((request:RequestWithIdentity, response, next) => {
    if (request.path === '/healthz') return next();
    if (request.path.startsWith('/v1/local/')) { if (!config.localToken || request.header('x-sulla-files-token') !== config.localToken) return response.status(401).json({ error: 'unauthorized local request' }); return next() }
    try { request.filesIdentity = verifyFilesIdentity(bearer(request), config.capabilitySigningKey, config.serverJwtSecret); next() } catch { response.status(401).json({ error: 'unauthorized' }) }
  });
  app.post('/v1/local/unlock', async(request, response) => {
    if (config.mode !== 'desktop') return response.sendStatus(404);
    let key:Buffer | undefined;
    try {
      if (!config.keyring || typeof request.body?.masterKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(request.body.masterKey)) return response.status(400).json({ error: 'Invalid Files master key' });
      key = Buffer.from(request.body.masterKey, 'base64'); delete request.body.masterKey;
      await serial(async() => {
        if (config.filesRoot) {
          config.legacyPreflight = await runLegacyPreflight(db, config.filesRoot, { caseInsensitive: config.caseInsensitiveRoot });
          if (config.legacyPreflight.state === 'secure-import-required') throw new Error('Legacy Files secure import is required');
        }
        await config.keyring!.unlock(key!, config.capabilitySigningKey);
        try { await onUnlock?.(); ready = true } catch (error) { ready = false; try { await onLock?.() } finally { config.keyring!.close() } throw error }
      });
      return response.json({ ok: true });
    } catch { return response.status(503).json({ error: 'Files unlock failed; existing data was preserved' }) }
    finally { key?.fill(0); if (request.body) delete request.body.masterKey }
  });
  app.post('/v1/local/lock', async(_request, response) => {
    if (config.mode !== 'desktop') return response.sendStatus(404);
    await serial(async() => { ready = false; try { await onLock?.() } finally { config.keyring?.close() } }); response.json({ ok: true });
  });
  app.use((request, response, next) => {
    if (request.path !== '/healthz' && !ready) return response.status(503).json({ code: 'FILES_LOCKED', error: 'Files is locked; Desktop keychain unlock is required' });
    next();
  });
  const identity = (request:RequestWithIdentity):FilesIdentity => { if (!request.filesIdentity) throw new HttpError(401, 'identity required'); return request.filesIdentity };
  async function collectionRow(collectionId:string):Promise<any> { const result = await db.query('SELECT * FROM collections WHERE id=$1', [collectionId]); if (!result.rows[0]) throw new HttpError(404, 'collection not found'); return result.rows[0] }
  async function grants(request:RequestWithIdentity, collectionId:string):Promise<{ role?: string; paths: { folderPath: string; role: string }[]; collection: any }> {
    return resolveCollectionGrants(db, identityDb, identity(request), collectionId);
  }
  function requireScratchRun(actor:FilesIdentity, collection:any):void {
    if (collection.kind !== 'scratch' || (!actor.agentId && !actor.jobId)) return;
    if (!actor.jobId || collection.agent_run_id !== actor.jobId) throw new HttpError(403, 'scratch collection is scoped to its owner and agent run');
    if (collection.thread_id && actor.threadId && collection.thread_id !== actor.threadId) throw new HttpError(403, 'scratch collection belongs to another thread');
  }
  async function requireCollection(request:RequestWithIdentity, collectionId:string, right:Right, allowShared = false) {
    const actor = identity(request);
    if (right === 'view' && (actor.agentId || actor.jobId)) right = 'use-by-agents';
    const access = await grants(request, collectionId);
    requireScratchRun(actor, access.collection);
    if ((access.role && ROLE_LEVEL[access.role] >= ROLE_LEVEL[right]) || (allowShared && access.paths.some(path => ROLE_LEVEL[path.role] >= ROLE_LEVEL[right]))) return access;
    throw new HttpError(403, 'access denied');
  }
  async function requirePath(request:RequestWithIdentity, collectionId:string, path:string, right:Right) {
    if (isProtectedPath(path)) throw protectedPathError();
    const actor = identity(request);
    if (right === 'view' && (actor.agentId || actor.jobId)) right = 'use-by-agents';
    const access = await grants(request, collectionId);
    requireScratchRun(actor, access.collection);
    if (access.role && ROLE_LEVEL[access.role] >= ROLE_LEVEL[right]) return access;
    if (access.paths.some(grant => ROLE_LEVEL[grant.role] >= ROLE_LEVEL[right] && (path === grant.folderPath || path.startsWith(`${ grant.folderPath }/`)))) return access;
    throw new HttpError(403, 'access denied');
  }
  async function fileRow(fileId:string):Promise<any> { const result = await db.query('SELECT * FROM files WHERE id=$1', [fileId]); if (!result.rows[0]) throw new HttpError(404, 'file not found'); await assertUnprotectedFile(db, result.rows[0]); return result.rows[0] }
  async function requireFile(request:RequestWithIdentity, fileId:string, right:Right):Promise<any> { const file = await fileRow(fileId); await requirePath(request, file.collection_id, file.path, right); return file }
  async function audit(request:RequestWithIdentity, action:string, file?:any, details:Record<string, unknown> = {}):Promise<void> { const actor = identity(request); await db.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,org_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, file?.id ?? null, file?.current_version_id ?? null, action, details.orgId ?? null, details]) }
  function sendContent(request:express.Request, response:express.Response, content:{ buffer: Buffer; mime: string }, cache = 'private, max-age=300') {
    response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('Cache-Control', cache); response.type(content.mime); const range = request.header('range'); if (!range) return response.send(content.buffer);
    const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match) return response.status(416).end(); const start = match[1] ? Number(match[1]) : 0; const end = match[2] ? Number(match[2]) : content.buffer.length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= content.buffer.length) return response.status(416).end();
    response.status(206).setHeader('Content-Range', `bytes ${ start }-${ end }/${ content.buffer.length }`); response.setHeader('Content-Length', end - start + 1); return response.send(content.buffer.subarray(start, end + 1));
  }
  async function insertVersion(client:pg.PoolClient, input:{ collectionId: string; fileId?: string; path: string; mime: string; bytes: Buffer; actor: FilesIdentity; createdByType?: string; createdById?: string; message: string; baseVersionId?: string | null }) {
    const { data: dataKey, dedup: dedupKey } = await config.keyring!.keys(input.collectionId); const chunkIds:string[] = []; const chunks:{ id: string; size: number; storedSize: number }[] = [];
    for (let offset = 0; offset < Math.max(1, input.bytes.length); offset += CHUNK_BYTES) { const plain = input.bytes.subarray(offset, Math.min(input.bytes.length, offset + CHUNK_BYTES)); const id = chunkId(plain, dedupKey); chunkIds.push(id); if (!await store.has(input.collectionId, id)) { const encrypted = await encryptChunk(plain, dataKey, id); await store.put(input.collectionId, id, encrypted); chunks.push({ id, size: plain.length, storedSize: encrypted.length }) } }
    const manifestHash = createHash('sha256').update(JSON.stringify({ ids: chunkIds, size: input.bytes.length })).digest('hex'); await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [manifestHash, JSON.stringify(chunkIds), input.bytes.length]);
    for (const chunk of chunks) await client.query(`INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,0) ON CONFLICT DO NOTHING`, [input.collectionId, chunk.id, chunk.size, chunk.storedSize, `chunks/${ input.collectionId }/${ chunk.id }`]);
    let file:any; if (input.fileId) { file = (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [input.fileId])).rows[0]; if (file?.collection_id !== input.collectionId) throw new HttpError(404, 'file not found'); await client.query('UPDATE files SET path=$2,mime=$3,size=$4,deleted_at=NULL,updated_at=NOW() WHERE id=$1', [file.id, input.path, input.mime, input.bytes.length]) } else file = (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [input.collectionId, input.path, input.createdByType ?? 'user', input.createdById ?? input.actor.userId, input.mime, input.bytes.length])).rows[0];
    const parent = input.baseVersionId === undefined ? file.current_version_id : input.baseVersionId; const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$3) RETURNING *`, [file.id, input.collectionId, parent, manifestHash, input.bytes.length, input.createdByType ?? 'user', input.createdById ?? input.actor.userId, input.message, input.actor.deviceId || 'server-web'])).rows[0];
    await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [file.id, version.id]); await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [input.collectionId, chunkIds]); await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [input.collectionId, file.id, version.id]); return { ...file, current_version_id: version.id, size: input.bytes.length, path: input.path, mime: input.mime };
  }

  async function ensureAgentCollection(request:RequestWithIdentity, requestedId?:unknown):Promise<any> {
    const actor = identity(request);
    if (requestedId) {
      const collection = await collectionRow(String(requestedId));
      if (collection.compatibility_state !== 'native') throw new HttpError(409, 'Legacy collection content requires explicit secure import before agent access');
      await requirePath(request, collection.id, cleanPath(request.body.path, false), 'edit');
      if (collection.kind === 'scratch' && (!actor.jobId || collection.owner_user_id !== actor.userId || collection.agent_run_id !== actor.jobId)) throw new HttpError(403, 'scratch collection is scoped to its owner and agent run');
      return collection;
    }
    if (!actor.jobId) {
      const existing = (await db.query("SELECT * FROM collections WHERE owner_user_id=$1 AND kind='knowledge' AND compatibility_state='native' ORDER BY created_at LIMIT 1", [actor.userId])).rows[0];
      if (existing) return existing;
    } else {
      const existing = (await db.query("SELECT * FROM collections WHERE owner_user_id=$1 AND agent_run_id=$2 AND kind='scratch'", [actor.userId, actor.jobId])).rows[0];
      if (existing) {
        if (existing.thread_id && actor.threadId && existing.thread_id !== actor.threadId) throw new HttpError(403, 'agent run belongs to another thread');
        return existing;
      }
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID(); const kind = actor.jobId ? 'scratch' : 'knowledge';
      const wrapped = await config.keyring!.create(id, client);
      const row = (await client.query(`INSERT INTO collections
        (id,org_id,owner_user_id,agent_run_id,thread_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy)
        VALUES($1,$2,$3,$4,$5,$6,$7,'desktop-only',$8,$9,$10) RETURNING *`,
      [id, actor.orgId ?? null, actor.userId, actor.jobId ?? null, actor.threadId ?? null, actor.jobId ? `Scratch ${ actor.jobId }` : 'Knowledge', kind, wrapped.data, wrapped.dedup, actor.jobId ? { ttlDaysAfterRun: 14 } : {}])).rows[0];
      await client.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage')", [id, actor.userId]);
      await client.query('COMMIT'); return row;
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  app.get('/healthz', (_request, response) => response.json({ ok: true, mode: config.mode, locked: !ready, legacyImport: config.legacyPreflight }));
  app.get('/v1/local/status', (_request, response) => response.json(manager ? manager.status() : { state: 'error', pendingFiles: 0, lastError: 'watched folder disabled', serverConfigured: false }));
  app.get('/v1/local/recent', async(request, response, next) => { try { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); response.json(await manager.recent(Number(request.query.limit ?? 4), typeof request.query.path === 'string' ? request.query.path : undefined)) } catch (error) { next(error) } });
  app.post('/v1/local/rescan', (_request, response) => { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); manager.rescan().catch(error => console.error('[SullaFiles] rescan failed', error)); response.status(202).json({ accepted: true }) });
  app.post('/v1/local/pause', async(request, response, next) => { try { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); response.json(await manager.setPaused(Boolean(request.body.paused))) } catch (error) { next(error) } });
  app.post('/v1/local/sync', (_request, response) => { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); manager.sync().catch(error => console.error('[SullaFiles] sync failed', error)); response.status(202).json({ accepted: true }) });
  app.post('/v1/local/maintenance', async(_request, response, next) => { const client = await db.connect(); try {
    await client.query('BEGIN'); const now = new Date();
    const expired = (await client.query('SELECT * FROM files WHERE expires_at<$1 AND deleted_at IS NULL FOR UPDATE', [now])).rows;
    for (const file of expired) {
      const deleted = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id)
        VALUES($1,$2,$3,NULL,0,TRUE,'agent-run','scratch-maintenance','Scratch TTL expired','scratch-maintenance') RETURNING id`, [file.id, file.collection_id, file.current_version_id])).rows[0];
      await client.query('UPDATE files SET current_version_id=$2,deleted_at=$3,updated_at=$3 WHERE id=$1', [file.id, deleted.id, now]);
      await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [file.collection_id, file.id, deleted.id]);
    }
    await client.query('COMMIT');
    response.json({ expiredFiles: expired.length });
  } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() } });

  app.post('/v1/search', async(request:RequestWithIdentity, response, next) => { try { if (!search) return response.status(503).json({ error: 'search unavailable' }); response.json(await search.search(request.body, await searchableScopes(db, identityDb, identity(request)))) } catch (error) { next(error) } });
  app.get('/v1/local/shares/:id/content', async(request, response, next) => { try { const content = await shares.content(request.params.id, String(request.query.path ?? '')); response.type(content.mime).setHeader('X-Sulla-Filename', encodeURIComponent(content.name)).send(content.bytes) } catch (error) { next(error) } });
  app.post('/v1/links', async(request:RequestWithIdentity, response, next) => {
    try {
      if (request.body.fileId) await requireFile(request, String(request.body.fileId), 'view');
      else await requirePath(request, String(request.body.collectionId ?? ''), cleanPath(request.body.folderPath, false), 'view');
      const actor = identity(request);
      response.status(201).json(await shares.create({ user: actor.userId, device: actor.deviceId || '' }, request.body, request.header('x-sulla-cloud-token') ?? ''));
    } catch (error) { next(error) }
  });
  app.get('/v1/links', async(request:RequestWithIdentity, response, next) => { try { const actor = identity(request); response.json(await shares.list({ user: actor.userId, device: actor.deviceId || '' }, request.header('x-sulla-cloud-token') ?? undefined)) } catch (error) { next(error) } });
  app.delete('/v1/links/:id', async(request:RequestWithIdentity, response, next) => { try { const actor = identity(request); response.json(await shares.revoke({ user: actor.userId, device: actor.deviceId || '' }, request.params.id, request.header('x-sulla-cloud-token') ?? undefined)) } catch (error) { next(error) } });
  app.patch('/v1/links/:id', async(request:RequestWithIdentity, response, next) => { try { const actor = identity(request); response.json(await shares.setKeepAvailable({ user: actor.userId, device: actor.deviceId || '' }, request.params.id, Boolean(request.body.keepAvailable), request.header('x-sulla-cloud-token') ?? '')) } catch (error) { next(error) } });

  app.get('/v1/collections', async(request:RequestWithIdentity, response, next) => { try { const rows = await db.query("SELECT * FROM collections WHERE kind='knowledge' ORDER BY name"); const visible:any[] = []; for (const collection of rows.rows) { const access = await grants(request, collection.id); if (access.role || access.paths.length) visible.push({ ...collection, access_role: access.role ?? null, shared_folders: access.paths }); } response.json(visible) } catch (error) { next(error) } });
  app.post('/v1/agent-files/query', async(request:RequestWithIdentity, response, next) => {
    try {
      const runIds = Array.isArray(request.body.runIds) ? [...new Set(request.body.runIds.filter((value:unknown):value is string => typeof value === 'string' && value.length > 0))].slice(0, 100) : [];
      if (!runIds.length) return response.json([]);
      const actor = identity(request); const threadId = typeof request.body.threadId === 'string' ? request.body.threadId : '';
      if (!threadId) throw new HttpError(400, 'threadId is required');
      const legacy = await db.query(`SELECT count(*)::int AS count FROM files f JOIN collections c ON c.id=f.collection_id
        JOIN file_versions v ON v.id=f.current_version_id JOIN collections chunks ON chunks.id=v.chunk_collection_id
        WHERE c.owner_user_id=$1 AND (c.compatibility_state='legacy-external-data' OR chunks.compatibility_state='legacy-external-data')
          AND (c.agent_run_id=ANY($2::text[]) OR f.created_by_type='agent-run' AND f.created_by_id=ANY($2::text[]))`, [actor.userId, runIds]);
      if (Number(legacy.rows[0]?.count ?? 0) > 0) throw new HttpError(409, 'Legacy agent files need an explicit secure import from the retired external chunk store; records were preserved and were not opened');
      const rows = await db.query(`SELECT f.*,c.kind AS collection_kind,c.agent_run_id
        FROM files f JOIN collections c ON c.id=f.collection_id JOIN file_versions v ON v.id=f.current_version_id JOIN collections chunks ON chunks.id=v.chunk_collection_id
        WHERE c.owner_user_id=$1 AND c.compatibility_state='native' AND chunks.compatibility_state='native' AND (c.thread_id=$3 OR c.thread_id IS NULL)
          AND (c.agent_run_id=ANY($2::text[]) OR (f.created_by_type='agent-run' AND f.created_by_id=ANY($2::text[])))
          AND f.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id)
        ORDER BY f.updated_at DESC`, [actor.userId, runIds, threadId]);
      response.json(rows.rows.filter(row => !isProtectedPath(row.path)));
    } catch (error) { next(error) }
  });
  app.post('/v1/agent-files', async(request:RequestWithIdentity, response, next) => { const client = await db.connect(); try {
    const actor = identity(request); if (!actor.agentId && !actor.jobId) throw new HttpError(403, 'agent identity is required');
    const path = cleanPath(request.body.path, false); const collection = await ensureAgentCollection(request, request.body.collectionId);
    await requirePath(request, collection.id, path, 'edit');
    const bytes = request.body.contentBase64 !== undefined
      ? Buffer.from(String(request.body.contentBase64), 'base64')
      : Buffer.from(String(request.body.content ?? ''), 'utf8');
    if (bytes.byteLength > 12 * 1024 * 1024) throw new HttpError(413, 'agent file exceeds the 12 MiB tool limit');
    const existing = (await db.query('SELECT id FROM files WHERE collection_id=$1 AND path=$2', [collection.id, path])).rows[0];
    await client.query('BEGIN');
    const file = await insertVersion(client, { collectionId: collection.id, fileId: existing?.id, path, mime: String(request.body.mime || 'application/octet-stream'), bytes, actor, createdByType: 'agent-run', createdById: actor.jobId ?? actor.agentId!, message: String(request.body.message ?? 'Agent write') });
    const derived = Array.isArray(request.body.derivedFrom) ? request.body.derivedFrom.filter((value:unknown):value is string => typeof value === 'string') : [];
    await client.query("DELETE FROM edges WHERE src_type='file' AND src_id=$1 AND kind='derived_from'", [file.id]);
    for (const sourceId of derived) { const source = await requireFile(request, sourceId, 'view'); await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES('file',$1,'file',$2,'derived_from',$3) ON CONFLICT DO NOTHING`, [file.id, source.id, actor.jobId ?? actor.agentId!]) }
    await client.query('COMMIT'); await audit(request, 'put', file, { threadId: actor.threadId, agentRunId: actor.jobId });
    response.status(201).json({ fileId: file.id, versionId: file.current_version_id, collectionId: collection.id, path: file.path });
  } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() } });
  app.post('/v1/agent-files/ensure', async(request:RequestWithIdentity, response, next) => { try {
    const actor = identity(request); if (!actor.jobId) throw new HttpError(400, 'job identity is required');
    const collection = await ensureAgentCollection(request); response.status(201).json({ collectionId: collection.id });
  } catch (error) { next(error) } });
  app.get('/v1/agent-files/:id', async(request:RequestWithIdentity, response, next) => { try {
    const file = await requireFile(request, request.params.id, 'view');
    const versionId = typeof request.query.versionId === 'string' ? request.query.versionId : file.current_version_id;
    const version = (await db.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted', [versionId, file.id])).rows[0];
    if (!version) throw new HttpError(404, 'file version not found');
    const content = await loadFileContent(db, config, store, file.id, version.id); if (!content) throw new HttpError(404, 'file content not found');
    await audit(request, 'get', { ...file, current_version_id: version.id });
    response.json({ file, version, content_base64: content.buffer.toString('base64') });
  } catch (error) { next(error) } });
  app.post('/v1/file-edges', async(request:RequestWithIdentity, response, next) => { try {
    const file = await requireFile(request, String(request.body.fileId ?? ''), 'edit'); const target = await requireFile(request, String(request.body.targetFileId ?? ''), 'view');
    if (!['links_to', 'derived_from'].includes(request.body.kind)) throw new HttpError(400, 'invalid edge kind');
    await db.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,created_by) VALUES('file',$1,'file',$2,$3,$4) ON CONFLICT DO NOTHING`, [file.id, target.id, request.body.kind, identity(request).jobId ?? identity(request).userId]);
    response.status(204).end();
  } catch (error) { next(error) } });
  app.post('/v1/collections', async(request:RequestWithIdentity, response, next) => {
    try {
      const actor = identity(request); const collection = request.body.collection;
      if (collection.kind !== 'knowledge') throw new HttpError(400, 'only knowledge syncs');
      if (config.mode === 'server' && collection.org_id) {
        if (!identityDb) throw new HttpError(503, 'organization identity database is not configured');
        const membership = await identityDb.query(`SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='confirmed'`, [collection.org_id, actor.userId]);
        if (!membership.rowCount) throw new HttpError(403, 'organization access denied');
      }
      const created = await db.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encryption,encrypted_data_key,dedup_key_ciphertext,retention_policy) VALUES($1,$2,$3,$4,'knowledge','synced','org-readable',$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`, [collection.id, collection.org_id, actor.userId, collection.name, collection.encrypted_data_key, collection.dedup_key_ciphertext, collection.retention_policy ?? {}]);
      if (!created.rowCount) { const existing = await collectionRow(collection.id); if (existing.owner_user_id !== actor.userId) throw new HttpError(409, 'collection already exists'); } else await db.query("INSERT INTO collection_acl(collection_id,principal_type,principal_id,role) VALUES($1,'user',$2,'manage')", [collection.id, actor.userId]);
      response.json({ ok: true });
    } catch (error) { next(error) }
  });
  app.get('/v1/collections/:id/journal', async(request:RequestWithIdentity, response, next) => { try { const access = await requireCollection(request, request.params.id, 'view', true); const after = Number(request.query.after ?? 0); const params:any[] = [request.params.id, Number.isSafeInteger(after) ? after : 0]; let filter = ''; if (!access.role || ROLE_LEVEL[access.role] < ROLE_LEVEL.view) { params.push(access.paths.filter(path => ROLE_LEVEL[path.role] >= ROLE_LEVEL.view).map(path => path.folderPath)); filter = ` AND EXISTS (SELECT 1 FROM unnest($3::text[]) p WHERE f.path=p OR starts_with(f.path, p||'/'))` } const query = await db.query(`SELECT j.*,row_to_json(f.*) file,row_to_json(v.*) version,row_to_json(m.*) manifest FROM journal j JOIN files f ON f.id=j.file_id JOIN file_versions v ON v.id=j.version_id LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) AND j.collection_id=$1 AND j.seq>$2${ filter } ORDER BY j.seq LIMIT 1000`, params); response.json(query.rows.filter(row => !isProtectedPath(row.file.path))) } catch (error) { next(error) } });
  app.get('/v1/versions/:id', async(request:RequestWithIdentity, response, next) => { try { const query = await db.query(`SELECT row_to_json(v.*) version,row_to_json(m.*) manifest,row_to_json(f.*) file FROM file_versions v JOIN files f ON f.id=v.file_id LEFT JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1`, [request.params.id]); if (!query.rows[0]) return response.sendStatus(404); await assertUnprotectedFile(db, query.rows[0].file); await requirePath(request, query.rows[0].file.collection_id, query.rows[0].file.path, 'view'); response.json(query.rows[0]) } catch (error) { next(error) } });
  app.get('/v1/files/:id/recording-metadata', async(request:RequestWithIdentity, response, next) => { try {
    const query = await db.query(`SELECT f.collection_id,f.path,m.version_id,m.language,m.transcript,m.chapters,m.duration_seconds,m.generator,m.generated_at
      FROM recording_metadata m JOIN files f ON f.id=m.file_id WHERE m.file_id=$1`, [request.params.id]);
    if (!query.rows[0]) return response.sendStatus(404);
    await assertUnprotectedFile(db, { id: request.params.id, path: query.rows[0].path });
    await requirePath(request, query.rows[0].collection_id, query.rows[0].path, 'view');
    const { collection_id: _collectionId, path: _path, ...metadata } = query.rows[0]; response.json(metadata);
  } catch (error) { next(error) } });
  app.use('/v1/chunks/:collection/:id', async(request, _response, next) => {
    try {
      const protectedChunk = await db.query('SELECT 1 FROM files_protected_chunks WHERE collection_id=$1 AND chunk_id=$2', [request.params.collection, request.params.id]);
      if (protectedChunk.rowCount) throw protectedPathError();
      next();
    } catch (error) { next(error) }
  });
  app.head('/v1/chunks/:collection/:id', async(request:RequestWithIdentity, response, next) => { try { await requireCollection(request, request.params.collection, 'view', true); response.sendStatus(await store.has(request.params.collection, request.params.id) ? 204 : 404) } catch (error) { next(error) } });
  app.get('/v1/chunks/:collection/:id', async(request:RequestWithIdentity, response, next) => { try { await requireCollection(request, request.params.collection, 'view', true); response.type('application/octet-stream').send(await store.get(request.params.collection, request.params.id)) } catch (error) { next(error) } });
  app.put('/v1/chunks/:collection/:id', express.raw({ type: 'application/octet-stream', limit: '8mb' }), async(request:RequestWithIdentity, response, next) => { try { await requireCollection(request, request.params.collection, 'edit', true); await store.put(request.params.collection, request.params.id, request.body as Buffer); response.sendStatus(204) } catch (error) { next(error) } });
  async function prepare(request:RequestWithIdentity, bundle:any) { await requirePath(request, bundle.collectionId, cleanPath(bundle.file.path, false), 'edit'); if (bundle.version.chunk_collection_id !== bundle.collectionId) await requireCollection(request, bundle.version.chunk_collection_id, 'edit', true); const existing = (await db.query('SELECT id,collection_id,current_version_id FROM files WHERE id=$1 OR (collection_id=$2 AND path=$3) ORDER BY id=$1 DESC LIMIT 1', [bundle.file.id, bundle.collectionId, bundle.file.path])).rows[0]; if (existing && existing.collection_id !== bundle.collectionId) throw new HttpError(403, 'file belongs to another collection'); const missing:string[] = []; for (const id of bundle.manifest?.chunk_ids ?? []) if (!await store.has(bundle.version.chunk_collection_id, id)) missing.push(id); const base = bundle.baseServerVersionId ?? null; const conflict = Boolean(existing?.current_version_id && existing.current_version_id !== base && (base || existing.id !== bundle.file.id)); return { existing, missing, conflict, currentVersionId: existing?.current_version_id ?? null, canonicalFileId: existing?.id ?? bundle.file.id } }
  app.post('/v1/versions/prepare', async(request:RequestWithIdentity, response, next) => { try { const result = await prepare(request, request.body); response.json({ missing: result.missing, currentVersionId: result.currentVersionId, canonicalFileId: result.canonicalFileId, conflict: result.conflict }) } catch (error) { next(error) } });
  app.post('/v1/versions/commit', async(request:RequestWithIdentity, response, next) => { const client = await db.connect(); try { const bundle = request.body; const actor = identity(request); const checked = await prepare(request, bundle); if (checked.missing.length) return response.status(400).json({ error: 'manifest chunks missing', missing: checked.missing }); if (checked.conflict) return response.status(409).json({ conflict: true, currentVersionId: checked.currentVersionId }); const fileId = checked.canonicalFileId; await client.query('BEGIN'); if (bundle.manifest) await client.query('INSERT INTO manifests(hash,chunk_ids,total_size) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [bundle.manifest.hash, JSON.stringify(bundle.manifest.chunk_ids), bundle.manifest.total_size]); for (const chunk of bundle.chunks ?? []) await client.query('INSERT INTO chunks(collection_id,id,size,stored_size,location,refcount) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(collection_id,id) DO UPDATE SET refcount=chunks.refcount+1', [bundle.version.chunk_collection_id, chunk.id, chunk.size, chunk.stored_size, chunk.location]); await client.query(`INSERT INTO files(id,collection_id,path,created_by_type,created_by_id,mime,size,search_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET path=EXCLUDED.path,mime=EXCLUDED.mime,size=EXCLUDED.size,search_text=EXCLUDED.search_text,deleted_at=$9,updated_at=NOW()`, [fileId, bundle.collectionId, bundle.file.path, bundle.file.created_by_type, bundle.file.created_by_id, bundle.file.mime, bundle.file.size, bundle.file.search_text, bundle.version.deleted ? new Date() : null]); await client.query(`INSERT INTO file_versions(id,file_id,chunk_collection_id,parent_version_id,manifest_hash,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`, [bundle.version.id, fileId, bundle.version.chunk_collection_id, checked.currentVersionId, bundle.manifest?.hash ?? null, bundle.version.size, bundle.version.deleted, bundle.version.created_by_type, bundle.version.created_by_id, bundle.version.message, actor.deviceId, checked.currentVersionId]); await client.query('UPDATE files SET current_version_id=$2,deleted_at=$3 WHERE id=$1', [fileId, bundle.version.id, bundle.version.deleted ? new Date() : null]); await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [bundle.collectionId, fileId, bundle.version.id, bundle.version.deleted ? 'delete' : 'put']); await client.query('COMMIT'); response.json({ ok: true, versionId: bundle.version.id, fileId }) } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() } });

  app.get('/v1/files', async(request:RequestWithIdentity, response, next) => { try { const collectionId = String(request.query.collectionId ?? ''); if (!collectionId) throw new HttpError(400, 'collectionId is required'); const path = cleanPath(String(request.query.path ?? '')); const access = await requireCollection(request, collectionId, 'view', true); const trash = request.query.trash === 'true'; const params:any[] = [collectionId, path ? `${ path }/` : '']; let filter = ''; if (!access.role || ROLE_LEVEL[access.role] < ROLE_LEVEL.view) { params.push(access.paths.map(value => value.folderPath)); filter = ` AND EXISTS (SELECT 1 FROM unnest($3::text[]) p WHERE f.path=p OR starts_with(f.path, p||'/'))` } const rows = await db.query(`SELECT f.*,v.created_at AS version_created_at,v.created_by_type AS version_created_by_type,v.created_by_id AS version_created_by_id FROM files f LEFT JOIN file_versions v ON v.id=f.current_version_id WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) AND f.collection_id=$1 AND ($2 = '' OR starts_with(f.path, $2))${ trash ? ' AND f.deleted_at IS NOT NULL' : ' AND f.deleted_at IS NULL' }${ filter } ORDER BY f.path`, params); response.json(rows.rows.filter(row => !row.path || !isProtectedPath(row.path))) } catch (error) { next(error) } });
  app.get('/v1/files/:id', async(request:RequestWithIdentity, response, next) => { try { const file = await requireFile(request, request.params.id, 'view'); const version = await db.query('SELECT * FROM file_versions WHERE id=$1', [file.current_version_id]); response.json({ ...file, provenance: { type: file.created_by_type, id: file.created_by_id }, version: version.rows[0] }) } catch (error) { next(error) } });
  app.get('/v1/files/:id/preview', async(request:RequestWithIdentity, response, next) => { try { const file = await requireFile(request, request.params.id, 'view'); const content = await loadFileContent(db, config, store, file.id, typeof request.query.versionId === 'string' ? request.query.versionId : undefined); if (!content) return response.sendStatus(404); await audit(request, 'preview', file); return sendContent(request, response, content) } catch (error) { next(error) } });
  app.get('/v1/files/:id/thumbnail', async(request:RequestWithIdentity, response, next) => { try { const file = await requireFile(request, request.params.id, 'view'); const content = await thumbnail(db, config, store, file.id, typeof request.query.versionId === 'string' ? request.query.versionId : undefined); if (!content) return response.sendStatus(404); return sendContent(request, response, content, 'private, max-age=86400') } catch (error) { next(error) } });
  app.get('/v1/files/:id/history', async(request:RequestWithIdentity, response, next) => { try { await requireFile(request, request.params.id, 'view'); const rows = await db.query('SELECT * FROM file_versions WHERE file_id=$1 ORDER BY created_at DESC', [request.params.id]); response.json(rows.rows.filter(row => !row.path || !isProtectedPath(row.path))) } catch (error) { next(error) } });
  app.put('/v1/files/upload', express.raw({ type: '*/*', limit: '2gb' }), async(request:RequestWithIdentity, response, next) => { const client = await db.connect(); try { const collectionId = String(request.query.collectionId ?? ''); const path = cleanPath(String(request.query.path ?? ''), false); await requirePath(request, collectionId, path, 'edit'); const actor = identity(request); await client.query('BEGIN'); const file = await insertVersion(client, { collectionId, path, mime: request.header('content-type') ?? 'application/octet-stream', bytes: Buffer.from(request.body as Buffer), actor, message: 'Uploaded' }); await client.query('COMMIT'); await audit(request, 'upload', file); response.status(201).json(file) } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() } });
  app.delete('/v1/files/:id', async(request:RequestWithIdentity, response, next) => { const client = await db.connect(); try { const file = await requireFile(request, request.params.id, 'edit'); const actor = identity(request); await client.query('BEGIN'); const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id) VALUES($1,$2,$3,0,TRUE,'user',$4,'Moved to Trash',$5,$3) RETURNING id`, [file.id, file.collection_id, file.current_version_id, actor.userId, actor.deviceId || 'server-web'])).rows[0]; await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [file.id, version.id]); await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [file.collection_id, file.id, version.id]); await client.query('COMMIT'); await audit(request, 'trash', { ...file, current_version_id: version.id }); response.status(204).end() } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() } });
  app.get('/v1/trash', async(request:RequestWithIdentity, response, next) => { try { const collectionId = String(request.query.collectionId ?? ''); await requireCollection(request, collectionId, 'view', true); const rows = await db.query(`SELECT * FROM files WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=files.id) AND collection_id=$1 AND deleted_at IS NOT NULL AND deleted_at > NOW()-INTERVAL '90 days' ORDER BY deleted_at DESC`, [collectionId]); const allowed = []; for (const file of rows.rows) { try { await requirePath(request, collectionId, file.path, 'view'); allowed.push(file) } catch { /* filtered */ } } response.json(allowed) } catch (error) { next(error) } });
  app.post('/v1/trash/:id/restore', async(request:RequestWithIdentity, response, next) => { const client = await db.connect(); try { const file = await requireFile(request, request.params.id, 'edit'); const actor = identity(request); const source = (await db.query('SELECT * FROM file_versions WHERE file_id=$1 AND NOT deleted AND manifest_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1', [file.id])).rows[0]; if (!source) throw new HttpError(409, 'no restorable version'); await client.query('BEGIN'); const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id) VALUES($1,$2,$3,$4,$5,'user',$6,'Restored from Trash',$7,$3) RETURNING id`, [file.id, source.chunk_collection_id, file.current_version_id, source.manifest_hash, source.size, actor.userId, actor.deviceId || 'server-web'])).rows[0]; await client.query('UPDATE files SET current_version_id=$2,deleted_at=NULL,size=$3,updated_at=NOW() WHERE id=$1', [file.id, version.id, source.size]); await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'restore')", [file.collection_id, file.id, version.id]); await client.query('COMMIT'); await audit(request, 'trash-restore', { ...file, current_version_id: version.id }); response.json({ ok: true, versionId: version.id }) } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() } });
  app.post('/v1/files/:id/restore', async(request:RequestWithIdentity, response, next) => { const client = await db.connect(); try { const file = await requireFile(request, request.params.id, 'edit'); const actor = identity(request); const source = (await db.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 AND NOT deleted', [request.body.versionId, file.id])).rows[0]; if (!source) throw new HttpError(404, 'version not found'); await client.query('BEGIN'); const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id) VALUES($1,$2,$3,$4,$5,'user',$6,'Restored version',$7,$3) RETURNING id`, [file.id, source.chunk_collection_id, file.current_version_id, source.manifest_hash, source.size, actor.userId, actor.deviceId || 'server-web'])).rows[0]; await client.query('UPDATE files SET current_version_id=$2,deleted_at=NULL,size=$3,updated_at=NOW() WHERE id=$1', [file.id, version.id, source.size]); await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'restore')", [file.collection_id, file.id, version.id]); await client.query('COMMIT'); await audit(request, 'version-restore', { ...file, current_version_id: version.id }); response.json({ ok: true, versionId: version.id }) } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() } });

  app.get('/v1/collections/:id/shares', async(request:RequestWithIdentity, response, next) => { try { await requireCollection(request, request.params.id, 'manage'); const rows = await db.query('SELECT * FROM folder_shares WHERE collection_id=$1 ORDER BY folder_path,principal_type,principal_id', [request.params.id]); response.json(rows.rows.filter(row => !row.path || !isProtectedPath(row.path))) } catch (error) { next(error) } });
  app.post('/v1/collections/:id/shares', async(request:RequestWithIdentity, response, next) => { try { const access = await requireCollection(request, request.params.id, 'manage'); const folderPath = cleanPath(request.body.folderPath, false); const principalType = request.body.principalType; const principalId = String(request.body.principalId ?? ''); const role = request.body.role; if (!identityDb || !access.collection.org_id) throw new HttpError(409, 'organization identity is not configured'); if (!['user', 'group'].includes(principalType) || !principalId || !['view', 'edit'].includes(role)) throw new HttpError(400, 'principalType, principalId, and role are required'); const exists = principalType === 'user' ? await identityDb.query(`SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='confirmed'`, [access.collection.org_id, principalId]) : await identityDb.query('SELECT 1 FROM org_groups WHERE org_id=$1 AND id=$2', [access.collection.org_id, principalId]); if (!exists.rowCount) throw new HttpError(400, 'principal is not a confirmed member or group in this organization'); const actor = identity(request); const row = await db.query(`INSERT INTO folder_shares(collection_id,folder_path,principal_type,principal_id,role,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(collection_id,folder_path,principal_type,principal_id) DO UPDATE SET role=EXCLUDED.role,updated_at=NOW() RETURNING *`, [request.params.id, folderPath, principalType, principalId, role, actor.userId]); await audit(request, 'share-folder', undefined, { orgId: access.collection.org_id, collectionId: request.params.id, folderPath, principalType, principalId, role }); response.status(201).json(row.rows[0]) } catch (error) { next(error) } });
  app.delete('/v1/collections/:id/shares', async(request:RequestWithIdentity, response, next) => { try { const access = await requireCollection(request, request.params.id, 'manage'); const folderPath = cleanPath(request.body.folderPath, false); const deleted = await db.query('DELETE FROM folder_shares WHERE collection_id=$1 AND folder_path=$2 AND principal_type=$3 AND principal_id=$4 RETURNING id', [request.params.id, folderPath, request.body.principalType, request.body.principalId]); if (!deleted.rowCount) throw new HttpError(404, 'share not found'); await audit(request, 'unshare-folder', undefined, { orgId: access.collection.org_id, collectionId: request.params.id, folderPath, principalType: request.body.principalType, principalId: request.body.principalId }); response.status(204).end() } catch (error) { next(error) } });
  app.get('/v1/orgs/:orgId/members', async(request:RequestWithIdentity, response, next) => { try { if (!identityDb) throw new HttpError(409, 'organization identity is not configured'); const member = await identityDb.query(`SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='confirmed'`, [request.params.orgId, identity(request).userId]); if (!member.rowCount) throw new HttpError(403, 'access denied'); const members = await identityDb.query(`SELECT u.id::text,u.email,om.role FROM org_members om JOIN users u ON u.id=om.user_id WHERE om.org_id=$1 AND om.status='confirmed' AND u.disabled_at IS NULL ORDER BY u.email`, [request.params.orgId]); const groups = await identityDb.query(`SELECT g.id::text,g.encrypted_name,COALESCE(json_agg(gm.user_id::text) FILTER(WHERE gm.user_id IS NOT NULL),'[]') members FROM org_groups g LEFT JOIN group_members gm ON gm.group_id=g.id WHERE g.org_id=$1 GROUP BY g.id ORDER BY g.created_at`, [request.params.orgId]); response.json({ members: members.rows, groups: groups.rows }) } catch (error) { next(error) } });
  app.post('/v1/agent-files/:id/keep', async(request:RequestWithIdentity, response, next) => { const client = await db.connect(); try {
    const source = await requireFile(request, request.params.id, 'edit'); const targetCollectionId = String(request.body.collectionId ?? ''); const targetPath = cleanPath(String(request.body.path ?? source.path), false);
    await requirePath(request, targetCollectionId, targetPath, 'edit'); const target = await collectionRow(targetCollectionId); if (target.kind === 'scratch') throw new HttpError(400, 'Keep target must be a permanent collection');
    const content = await loadFileContent(db, config, store, source.id, source.current_version_id); if (!content) throw new HttpError(404, 'source content not found');
    const existing = (await db.query('SELECT id FROM files WHERE collection_id=$1 AND path=$2', [targetCollectionId, targetPath])).rows[0]; const actor = identity(request);
    await client.query('BEGIN');
    const kept = await insertVersion(client, { collectionId: targetCollectionId, fileId: existing?.id, path: targetPath, mime: source.mime, bytes: content.buffer, actor, createdByType: source.created_by_type, createdById: source.created_by_id, message: `Kept from agent run ${ source.created_by_id }` });
    await client.query('UPDATE files SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [source.id]);
    await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,props,created_by) VALUES('file',$1,'agent-run',$2,'created_by',$3,$4) ON CONFLICT DO NOTHING`, [kept.id, source.created_by_id, JSON.stringify({ keptFromCollectionId: source.collection_id, sourceFileId: source.id }), actor.userId]);
    await client.query('COMMIT'); await audit(request, 'keep-agent-file', kept); response.json({ ...kept, provenance: { type: source.created_by_type, id: source.created_by_id } });
  } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() } });
  app.post('/v1/agent-runs/:runId/keep', async(request:RequestWithIdentity, response, next) => { const client = await db.connect(); try {
    const actor = identity(request); const source = (await db.query("SELECT * FROM collections WHERE owner_user_id=$1 AND agent_run_id=$2 AND kind='scratch'", [actor.userId, request.params.runId])).rows[0];
    if (!source) throw new HttpError(404, 'scratch run not found');
    requireScratchRun(actor, source);
    if (source.thread_id && actor.threadId && source.thread_id !== actor.threadId) throw new HttpError(403, 'scratch run belongs to another thread');
    const targetCollectionId = String(request.body.collectionId ?? ''); await requireCollection(request, targetCollectionId, 'edit'); const target = await collectionRow(targetCollectionId);
    if (target.kind === 'scratch') throw new HttpError(400, 'Keep target must be a permanent collection');
    const files = (await db.query('SELECT * FROM files WHERE collection_id=$1 AND created_by_id=$2 AND deleted_at IS NULL', [source.id, request.params.runId])).rows;
    const materialized = await Promise.all(files.map(async file => ({ file, content: await loadFileContent(db, config, store, file.id, file.current_version_id) })));
    await client.query('BEGIN'); let count = 0;
    for (const item of materialized) {
      if (!item.content) throw new HttpError(404, `source content not found for ${ item.file.path }`);
      const existing = (await client.query('SELECT id FROM files WHERE collection_id=$1 AND path=$2', [targetCollectionId, item.file.path])).rows[0];
      const kept = await insertVersion(client, { collectionId: targetCollectionId, fileId: existing?.id, path: item.file.path, mime: item.file.mime, bytes: item.content.buffer, actor, createdByType: item.file.created_by_type, createdById: item.file.created_by_id, message: `Kept from agent run ${ request.params.runId }` });
      await client.query('UPDATE files SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [item.file.id]);
      await client.query(`INSERT INTO edges(src_type,src_id,dst_type,dst_id,kind,props,created_by) VALUES('file',$1,'agent-run',$2,'created_by',$3,$4) ON CONFLICT DO NOTHING`, [kept.id, request.params.runId, JSON.stringify({ keptFromCollectionId: source.id, sourceFileId: item.file.id }), actor.userId]); count++;
    }
    await client.query('COMMIT'); response.json({ count });
  } catch (error) { await client.query('ROLLBACK'); next(error) } finally { client.release() } });
  app.post('/v1/agent-runs/:runId/end', async(request:RequestWithIdentity, response, next) => { try {
    const actor = identity(request); if (actor.jobId !== request.params.runId) throw new HttpError(403, 'run identity mismatch');
    const result = await db.query(`UPDATE files f SET expires_at=NOW()+INTERVAL '14 days',updated_at=NOW()
      FROM collections c WHERE f.collection_id=c.id AND c.owner_user_id=$1 AND c.agent_run_id=$2 AND c.kind='scratch' AND f.expires_at IS NULL AND f.deleted_at IS NULL RETURNING f.id`, [actor.userId, actor.jobId]);
    response.json({ count: result.rowCount ?? result.rows.length });
  } catch (error) { next(error) } });
  app.use((error:any, _request:any, response:any, _next:any) => response.status(error.status ?? (error.code === '23505' ? 409 : 500)).json({ error: _request.path === '/v1/local/unlock' || error.type === 'entity.parse.failed' ? 'Invalid request' : error.message ?? 'server error' })); return app;
}
