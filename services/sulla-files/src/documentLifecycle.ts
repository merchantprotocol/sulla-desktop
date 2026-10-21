import type { FilesIdentity } from './auth.js';
import type express from 'express';
import type pg from 'pg';

type Right = 'view' | 'edit' | 'manage';
type RequestWithIdentity = express.Request<Record<string, string>> & { filesIdentity?:FilesIdentity };

function httpError(status:number, message:string):Error & { status:number } {
  return Object.assign(new Error(message), { status });
}

function iso(value:any):string | undefined { return value?.toISOString?.() ?? value ?? undefined }

export function lifecycleFields(file:any) {
  const { search_text: _st, search_vector: _sv, ...rest } = file;
  return {
    ...rest,
    publication_state: rest.draft_version_id ? 'draft' : 'published',
    versioning: { enabled: file.versioning_enabled, majorMinor: file.major_minor_enabled, requireApproval: file.require_approval, requireCheckout: file.require_checkout },
    checkout: file.checked_out_by_user_id ? { userId: file.checked_out_by_user_id, deviceId: file.checked_out_by_device_id, at: iso(file.checked_out_at) } : null,
    retention: { mode: file.retention_mode, retainUntil: iso(file.retain_until), eventType: file.retention_event_type, eventOccurredAt: iso(file.retention_event_at), durationDays: file.retention_duration_days },
    record: { status: file.record_lock_type, lockedAt: iso(file.record_locked_at), lockedBy: file.record_locked_by },
    disposal: { status: file.disposal_status, reviewAt: iso(file.disposal_review_at), extendedUntil: iso(file.disposal_extended_until) },
  };
}

export function lifecycleCapabilities(_role:string | undefined, draftVisible:boolean) {
  return {canEdit:true,canManage:true,canViewDraft:draftVisible,canPublish:true};
}

export async function authorizedVersionId(db:pg.Pool, file:any, draftVisible:boolean, requested?:string):Promise<string> {
  const fallback = draftVisible ? file.current_version_id : file.published_version_id;
  const versionId = requested ?? fallback;
  if (!versionId) throw httpError(404, 'no published version is available');
  const version = (await db.query('SELECT id,publication_status FROM file_versions WHERE id=$1 AND file_id=$2 AND deleted=FALSE', [versionId, file.id])).rows[0];
  if (!version || (!draftVisible && version.publication_status !== 'published')) throw httpError(404, 'version not found');
  return version.id;
}

export async function drainPendingChunkGc(db:pg.Pool, deleteChunk:(collectionId:string, chunkId:string)=>Promise<void>, maxBatches = 5):Promise<void> {
  for (let batch = 0; batch < maxBatches; batch++) {
    const pending = await db.query('SELECT collection_id,chunk_id,audit_id FROM file_chunk_gc ORDER BY requested_at LIMIT 500');
    if (!pending.rowCount) break;
    for (const item of pending.rows) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE file_versions IN SHARE ROW EXCLUSIVE MODE');
      const queued = (await client.query('SELECT audit_id FROM file_chunk_gc WHERE collection_id=$1 AND chunk_id=$2 FOR UPDATE', [item.collection_id, item.chunk_id])).rows[0];
      if (!queued) { await client.query('COMMIT'); continue }
      const refs = Number((await client.query(`SELECT COUNT(DISTINCT v.id)::int refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
        WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2`, [item.collection_id, item.chunk_id])).rows[0].refs);
      await client.query('UPDATE chunks SET refcount=$3 WHERE collection_id=$1 AND id=$2', [item.collection_id, item.chunk_id, refs]);
      if (refs === 0) { await deleteChunk(item.collection_id, item.chunk_id); await client.query('DELETE FROM chunks WHERE collection_id=$1 AND id=$2', [item.collection_id, item.chunk_id]) }
      await client.query('DELETE FROM file_chunk_gc WHERE collection_id=$1 AND chunk_id=$2', [item.collection_id, item.chunk_id]);
      if (queued.audit_id && !(await client.query('SELECT 1 FROM file_chunk_gc WHERE audit_id=$1 LIMIT 1', [queued.audit_id])).rowCount) await client.query(`UPDATE audit_log SET details=jsonb_set(details,'{physicalChunkGc}',to_jsonb('complete'::text),TRUE) WHERE id=$1`, [queued.audit_id]);
      await client.query('COMMIT');
    } catch (error:any) {
      await client.query('ROLLBACK');
      await db.query('UPDATE file_chunk_gc SET last_error=$3 WHERE collection_id=$1 AND chunk_id=$2', [item.collection_id, item.chunk_id, String(error?.message ?? error).slice(0, 1000)]).catch(() => undefined);
    } finally { client.release() }
    }
    if (pending.rows.length < 500) break;
  }
}

export function registerDocumentLifecycleRoutes(app:express.Express, db:pg.Pool, deps:{
  identity(request:RequestWithIdentity):FilesIdentity;
  requireFile(request:RequestWithIdentity, fileId:string, right:Right):Promise<any>;
  audit(request:RequestWithIdentity, action:string, file?:any, details?:Record<string, unknown>):Promise<void>;
  deleteChunk(collectionId:string, chunkId:string):Promise<void>;
  disposeTrashReceipt?(receiptId:string):Promise<{state:'none'|'complete'|'recovery-required';error?:string}>;
}) {
  void drainPendingChunkGc(db, deps.deleteChunk).catch(error => console.warn('[SullaFiles] pending physical chunk cleanup failed:', error));
  const locked = async(client:pg.PoolClient, id:string) => {
    const row = (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) throw httpError(404, 'file not found');
    return row;
  };
  const transaction = async<T>(work:(client:pg.PoolClient)=>Promise<T>):Promise<T> => {
    const client = await db.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  };
  const journalLifecycle = async(client:pg.PoolClient, file:any, op:'lifecycle' | 'put' = 'lifecycle', explicitVersionId?:string) => {
    const versionId = explicitVersionId ?? file.current_version_id ?? file.published_version_id;
    if (versionId) await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [file.collection_id, file.id, versionId, op]);
  };

  app.patch('/v1/files/:id/lifecycle', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'manage');
    const allowed = ['enabled','majorMinor','requireApproval','requireCheckout'];
    if (!Object.keys(request.body ?? {}).every(key => allowed.includes(key))) throw httpError(400, 'unsupported lifecycle setting');
    const row = await transaction(async client => {
      const file = await locked(client, request.params.id);
      if (file.record_lock_type === 'policy') throw httpError(423, 'policy record lifecycle settings cannot be changed');
      const values = [request.body.enabled, request.body.majorMinor, request.body.requireApproval, request.body.requireCheckout]
        .map((value, index) => value === undefined ? [null, null] : [index + 1, Boolean(value)]);
      const result = await client.query(`UPDATE files SET
        versioning_enabled=COALESCE($2,versioning_enabled),major_minor_enabled=COALESCE($3,major_minor_enabled),
        require_approval=COALESCE($4,require_approval),require_checkout=COALESCE($5,require_checkout),
        lifecycle_generation=lifecycle_generation+1,updated_at=NOW() WHERE id=$1 RETURNING *`,
      [file.id, values[0][1], values[1][1], values[2][1], values[3][1]]);
      await journalLifecycle(client, result.rows[0]); return result.rows[0];
    });
    await deps.audit(request, 'lifecycle-settings', row); response.json(lifecycleFields(row));
  } catch (error) { next(error) } });

  app.post('/v1/files/:id/checkout', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'edit'); const actor = deps.identity(request);
    const row = await transaction(async client => {
      const file = await locked(client, request.params.id);
      if (file.record_lock_type !== 'none') throw httpError(423, 'record is locked');
      if (file.checked_out_by_user_id && (file.checked_out_by_user_id !== actor.userId || file.checked_out_by_device_id !== (actor.deviceId || 'server-web'))) throw httpError(409, 'file is checked out by another editor');
      const result = (await client.query(`UPDATE files SET checked_out_by_user_id=$2,checked_out_by_device_id=$3,checked_out_at=COALESCE(checked_out_at,NOW()),lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [file.id, actor.userId, actor.deviceId || 'server-web'])).rows[0];
      await journalLifecycle(client, result); return result;
    });
    await deps.audit(request, 'checkout', row); response.json(lifecycleFields(row));
  } catch (error) { next(error) } });

  app.delete('/v1/files/:id/checkout', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'edit'); const actor = deps.identity(request); const force = request.body?.force === true;
    if (force) await deps.requireFile(request, request.params.id, 'manage');
    const row = await transaction(async client => { const file = await locked(client, request.params.id); if (file.checked_out_by_user_id !== actor.userId && !force) throw httpError(409, 'only the checkout owner can discard checkout'); const result = (await client.query(`UPDATE files SET checked_out_by_user_id=NULL,checked_out_by_device_id=NULL,checked_out_at=NULL,lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [file.id])).rows[0]; await journalLifecycle(client, result); return result });
    await deps.audit(request, force ? 'checkout-force-release' : 'checkout-release', row); response.json(lifecycleFields(row));
  } catch (error) { next(error) } });

  const isAgent = (actor:FilesIdentity) => Boolean(actor.agentId || actor.jobId || actor.threadId);
  const requireHuman = (request:RequestWithIdentity) => {
    const actor = deps.identity(request);
    if (isAgent(actor)) throw httpError(403, 'human identity required');
    return actor;
  };
  const publishLocked = async(client:pg.PoolClient, request:RequestWithIdentity, versionId:string, releaseCheckout = false) => {
    const actor = requireHuman(request);
    const file = await locked(client, request.params.id);
    const active = (await client.query('SELECT files_retention_active(f) active FROM files f WHERE id=$1', [file.id])).rows[0]?.active;
    if (active) throw httpError(423, 'file is locked by record retention');
    if (!versionId) throw httpError(409, 'file has no draft to publish');
    const version = (await client.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 AND deleted=FALSE FOR UPDATE', [versionId, file.id])).rows[0];
    if (!version) throw httpError(404, 'version not found');
    if (version.publication_status === 'published') return file;
    const major = Number((await client.query('SELECT COALESCE(MAX(major_version),0)::int major FROM file_versions WHERE file_id=$1', [file.id])).rows[0].major) + 1;
    await client.query("UPDATE file_versions SET publication_status='superseded' WHERE file_id=$1 AND publication_status='published'", [file.id]);
    await client.query(`UPDATE file_versions SET publication_status='published',version_kind='major',major_version=$2,minor_version=0,published_at=NOW(),published_by=$3,version_comment=COALESCE($4,version_comment) WHERE id=$1`, [version.id, major, actor.userId, request.body?.comment ?? null]);
    const result = (await client.query(`UPDATE files SET published_version_id=$2,draft_version_id=CASE WHEN draft_version_id=$2 THEN NULL ELSE draft_version_id END,
      checked_out_by_user_id=CASE WHEN $3 THEN NULL ELSE checked_out_by_user_id END,checked_out_by_device_id=CASE WHEN $3 THEN NULL ELSE checked_out_by_device_id END,checked_out_at=CASE WHEN $3 THEN NULL ELSE checked_out_at END,
      lifecycle_generation=lifecycle_generation+1,updated_at=NOW() WHERE id=$1 RETURNING *`, [file.id, version.id, releaseCheckout])).rows[0];
    await journalLifecycle(client, result, 'put', version.id);
    return result;
  };
  const publish = async(request:RequestWithIdentity, requireExpected:boolean, releaseCheckout = false, explicitVersionId?:string) => {
    await deps.requireFile(request, request.params.id, 'manage');
    return transaction(async client => {
      const file = await locked(client, request.params.id);
      const versionId = explicitVersionId ?? String(request.body?.versionId ?? file.draft_version_id ?? '');
      if (requireExpected && request.body?.expectedDraftVersionId !== file.draft_version_id) throw httpError(409, 'draft changed while publication was starting');
      return publishLocked(client, request, versionId, releaseCheckout);
    });
  };

  app.get('/v1/files/:id/versions', async(request:RequestWithIdentity, response, next) => { try {
    const file = await deps.requireFile(request, request.params.id, 'view');
    const versions = await db.query(`SELECT id,major_version,minor_version,version_kind,publication_status,created_by_type,created_by_id,created_at,version_comment,size
      FROM file_versions WHERE file_id=$1 AND deleted=FALSE ORDER BY created_at DESC,id DESC`, [file.id]);
    response.json({
      fileId:file.id,draftVersionId:file.draft_version_id,publishedVersionId:file.published_version_id,
      recordLockType:file.record_lock_type,retentionMode:file.retention_mode,retainUntil:iso(file.retain_until),disposalStatus:file.disposal_status,
      versions:versions.rows.map(row => ({id:row.id,major:row.major_version,minor:row.minor_version,kind:row.version_kind,
        publication_status:row.publication_status,created_by:{type:row.created_by_type,id:row.created_by_id},created_at:iso(row.created_at),comment:row.version_comment,size:Number(row.size)})),
    });
  } catch (error) { next(error) } });

  app.post('/v1/files/:id/versions/:versionId/publish', async(request:RequestWithIdentity, response, next) => { try {
    requireHuman(request);
    const row = await publish(request, false, false, request.params.versionId);
    await deps.audit(request, 'publish', {...row,current_version_id:request.params.versionId}, {versionId:request.params.versionId,requestId:request.body?.requestId ?? null});
    response.json(lifecycleFields(row));
  } catch (error) { next(error) } });

  app.post('/v1/files/:id/versions/:versionId/publish-request', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'edit'); const actor = deps.identity(request);
    if (!isAgent(actor)) throw httpError(403, 'agent identity required');
    const reason = request.body?.reason == null ? null : String(request.body.reason).slice(0, 2000);
    const row = await transaction(async client => {
      const file = await locked(client, request.params.id);
      const version = (await client.query("SELECT id FROM file_versions WHERE id=$1 AND file_id=$2 AND deleted=FALSE AND publication_status='draft'", [request.params.versionId,file.id])).rows[0];
      if (!version) throw httpError(404, 'draft version not found');
      return (await client.query(`INSERT INTO files_publish_requests(file_id,version_id,requested_by,reason) VALUES($1,$2,$3,$4)
        ON CONFLICT(file_id,version_id) WHERE status='pending' DO UPDATE SET reason=COALESCE(EXCLUDED.reason,files_publish_requests.reason) RETURNING *`,
      [file.id,version.id,actor.jobId ?? actor.agentId ?? actor.userId,reason])).rows[0];
    });
    await deps.audit(request, 'publish-request', {id:request.params.id,current_version_id:request.params.versionId}, {requestId:row.id,reason});
    response.status(202).json(row);
  } catch (error) { next(error) } });

  app.get('/v1/files/publish-requests', async(request:RequestWithIdentity, response, next) => { try {
    requireHuman(request); const status = typeof request.query.status === 'string' ? request.query.status : 'pending';
    if (!['pending','approved','rejected','expired'].includes(status)) throw httpError(400, 'invalid publish request status');
    const rows = await db.query(`SELECT r.*,f.path,f.collection_id FROM files_publish_requests r JOIN files f ON f.id=r.file_id
      WHERE r.status=$1 AND ($2::uuid IS NULL OR r.file_id=$2) ORDER BY r.created_at`, [status,typeof request.query.fileId === 'string' ? request.query.fileId : null]);
    response.json({requests:rows.rows});
  } catch (error) { next(error) } });

  for (const decision of ['approve','reject'] as const) app.post(`/v1/files/publish-requests/:requestId/${decision}`, async(request:RequestWithIdentity, response, next) => { try {
    const actor = requireHuman(request);
    const result = await transaction(async client => {
      const publication = (await client.query('SELECT * FROM files_publish_requests WHERE id=$1 FOR UPDATE', [request.params.requestId])).rows[0];
      if (!publication) throw httpError(404, 'publish request not found');
      if (publication.status !== 'pending') throw httpError(409, `publish request is ${publication.status}`);
      request.params.id = publication.file_id;
      let file:any = await locked(client, publication.file_id);
      if (decision === 'approve') file = await publishLocked(client, request, publication.version_id);
      const decided = (await client.query(`UPDATE files_publish_requests SET status=$2,decided_by=$3,decided_at=NOW() WHERE id=$1 RETURNING *`, [publication.id,decision === 'approve' ? 'approved' : 'rejected',actor.userId])).rows[0];
      return {file,request:decided};
    });
    if (decision === 'approve') await deps.audit(request, 'publish', {...result.file,current_version_id:result.request.version_id}, {requestId:result.request.id,versionId:result.request.version_id});
    await deps.audit(request, decision === 'approve' ? 'publish-request-approve' : 'publish-request-reject',
      {...result.file,current_version_id:result.request.version_id}, {requestId:result.request.id,versionId:result.request.version_id});
    response.json(result);
  } catch (error) { next(error) } });

  // Compatibility endpoint retained for existing File Manager callers.
  app.post('/v1/files/:id/publish', async(request:RequestWithIdentity, response, next) => { try { requireHuman(request); const row = await publish(request, true); await deps.audit(request, 'publish', row, { versionId: row.published_version_id }); response.json(lifecycleFields(row)) } catch (error) { next(error) } });
  app.post('/v1/files/:id/checkin', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'edit'); const actor = deps.identity(request);
    if (request.body?.publish === true) { const row = await publish(request, false, true); await deps.audit(request, 'checkin-publish', row); return response.json(lifecycleFields(row)) }
    const row = await transaction(async client => {
      const file = await locked(client, request.params.id); if (file.record_lock_type !== 'none') throw httpError(423, 'record is locked');
      const actorDevice = actor.deviceId || 'server-web';
      if (file.require_checkout && (file.checked_out_by_user_id !== actor.userId || file.checked_out_by_device_id !== actorDevice)) throw httpError(409, 'file must be checked out by this editor');
      if (file.checked_out_by_user_id && file.checked_out_by_user_id !== actor.userId) throw httpError(409, 'file is checked out by another editor');
      const versionId = String(request.body?.versionId ?? file.draft_version_id ?? ''); const kind = request.body?.kind === 'major' ? 'major' : 'minor';
      const major = kind === 'major' ? Number((await client.query('SELECT COALESCE(MAX(major_version),0)::int n FROM file_versions WHERE file_id=$1', [file.id])).rows[0].n) + 1 : Number((await client.query('SELECT COALESCE(MAX(major_version),0)::int n FROM file_versions WHERE file_id=$1', [file.id])).rows[0].n);
      const minor = kind === 'major' ? 0 : Number((await client.query('SELECT COALESCE(MAX(minor_version),0)::int n FROM file_versions WHERE file_id=$1 AND major_version=$2', [file.id, major])).rows[0].n) + 1;
      const result = await client.query(`UPDATE file_versions SET version_comment=COALESCE($3,version_comment),version_kind=$4,major_version=$5,minor_version=$6 WHERE id=$1 AND file_id=$2 AND publication_status='draft' RETURNING id`, [versionId, file.id, request.body?.comment ?? null, kind, major, minor]);
      if (!result.rowCount) throw httpError(404, 'draft version not found');
      const updated = (await client.query(`UPDATE files SET checked_out_by_user_id=NULL,checked_out_by_device_id=NULL,checked_out_at=NULL,lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [file.id])).rows[0];
      await journalLifecycle(client, updated); return updated;
    });
    const versionId = String(request.body?.versionId ?? row.draft_version_id ?? '');
    await deps.audit(request, 'checkin', row, { versionId }); response.json(lifecycleFields(row));
  } catch (error) { next(error) } });

  app.patch('/v1/files/:id/retention', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'manage'); const actor = deps.identity(request); const mode = request.body?.mode;
    if (!['none','retain-until','event'].includes(mode)) throw httpError(400, 'retention mode must be none, retain-until, or event');
    const retainUntil = request.body?.retainUntil == null ? null : new Date(request.body.retainUntil);
    const eventAt = request.body?.eventOccurredAt == null ? null : new Date(request.body.eventOccurredAt);
    const days = request.body?.durationDays == null ? null : Number(request.body.durationDays);
    if (mode === 'retain-until' && (!retainUntil || Number.isNaN(retainUntil.valueOf()))) throw httpError(400, 'valid retainUntil is required');
    if (mode === 'event' && (typeof request.body?.eventType !== 'string' || !request.body.eventType.trim() || days === null || !Number.isInteger(days) || days < 0)) throw httpError(400, 'eventType and non-negative durationDays are required');
    const row = await transaction(async client => {
      const file = await locked(client, request.params.id);
      if (file.record_lock_type === 'policy') {
        const oldEnd = file.retention_mode === 'retain-until' ? file.retain_until : file.retention_mode === 'event' && file.retention_event_at && file.retention_duration_days != null ? new Date(new Date(file.retention_event_at).valueOf() + Number(file.retention_duration_days) * 86_400_000) : null;
        const newEnd = mode === 'retain-until' ? retainUntil : mode === 'event' && eventAt && days != null ? new Date(eventAt.valueOf() + days * 86_400_000) : null;
        if (!oldEnd || !newEnd || newEnd < new Date(oldEnd)) throw httpError(423, 'policy record retention cannot be shortened or cleared');
      }
      const updated = (await client.query(`UPDATE files SET retention_mode=$2,retain_until=$3,retention_event_type=$4,retention_event_at=$5,retention_duration_days=$6,disposal_status='none',disposal_review_at=NULL,lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [file.id, mode, mode === 'retain-until' ? retainUntil : null, mode === 'event' ? request.body.eventType.trim() : null, mode === 'event' ? eventAt : null, mode === 'event' ? days : null])).rows[0];
      await journalLifecycle(client, updated); return updated;
    });
    await deps.audit(request, 'retention-update', row, { mode, actor: actor.userId }); response.json(lifecycleFields(row));
  } catch (error) { next(error) } });

  app.post('/v1/files/:id/record-lock', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'manage'); const actor = deps.identity(request); const kind = request.body?.kind;
    if (kind !== 'ordinary' && kind !== 'policy') throw httpError(400, 'record lock kind must be ordinary or policy');
    const row = await transaction(async client => { const file = await locked(client, request.params.id); if (file.record_lock_type === 'policy' && kind !== 'policy') throw httpError(423, 'policy records cannot be downgraded'); const updated = (await client.query(`UPDATE files SET record_lock_type=$2,record_locked_at=COALESCE(record_locked_at,NOW()),record_locked_by=COALESCE(record_locked_by,$3),lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [file.id, kind, actor.userId])).rows[0]; await journalLifecycle(client, updated); return updated });
    await deps.audit(request, 'record-lock', row, { kind }); response.json(lifecycleFields(row));
  } catch (error) { next(error) } });
  app.delete('/v1/files/:id/record-lock', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'manage');
    const row = await transaction(async client => { const file = await locked(client, request.params.id); if (file.record_lock_type === 'policy') throw httpError(423, 'policy records cannot be unlocked through the ordinary records API'); const updated = (await client.query(`UPDATE files SET record_lock_type='none',record_locked_at=NULL,record_locked_by=NULL,lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [file.id])).rows[0]; await journalLifecycle(client, updated); return updated });
    await deps.audit(request, 'record-unlock', row); response.json(lifecycleFields(row));
  } catch (error) { next(error) } });
  app.post('/v1/files/:id/disposal-review', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'manage'); const decision = request.body?.decision;
    if (!['approve','reject','extend'].includes(decision)) throw httpError(400, 'disposal decision must be approve, reject, or extend');
    const row = await transaction(async client => {
      const file = await locked(client, request.params.id);
      const active = (await client.query('SELECT files_retention_active(f) active FROM files f WHERE id=$1', [file.id])).rows[0]?.active;
      if (decision === 'approve' && active) throw httpError(409, 'active retention or record lock prevents disposal approval');
      const extension = decision === 'extend' ? new Date(request.body?.extendedUntil) : null;
      if (decision === 'extend' && (!extension || Number.isNaN(extension.valueOf()) || extension <= new Date())) throw httpError(400, 'future extendedUntil is required');
      const updated = (await client.query(`UPDATE files SET disposal_status=$2,disposal_review_at=NOW(),disposal_extended_until=$3,lifecycle_generation=lifecycle_generation+1 WHERE id=$1 RETURNING *`, [file.id, decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'pending', extension])).rows[0];
      await journalLifecycle(client, updated); return updated;
    });
    await deps.audit(request, 'disposal-review', row, { decision }); response.json(lifecycleFields(row));
  } catch (error) { next(error) } });
  app.patch('/v1/files/:id/lifecycle-state', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'manage'); const incoming = request.body?.file;
    if (!incoming || incoming.id !== request.params.id || !Number.isInteger(Number(incoming.lifecycle_generation))) throw httpError(400, 'valid lifecycle state is required');
    if (!['none','retain-until','event'].includes(incoming.retention_mode) || !['none','ordinary','policy'].includes(incoming.record_lock_type) || !['none','pending','approved','rejected'].includes(incoming.disposal_status)) throw httpError(400, 'invalid lifecycle state');
    const result = await transaction(async client => {
      const current = await locked(client, request.params.id); const generation = Number(incoming.lifecycle_generation);
      if (generation <= Number(current.lifecycle_generation)) return { applied: false, file: current };
      if (current.record_lock_type === 'policy' && incoming.record_lock_type !== 'policy') return { applied: false, file: current };
      const oldEnd = current.retention_mode === 'retain-until' ? current.retain_until : current.retention_mode === 'event' && current.retention_event_at && current.retention_duration_days != null ? new Date(new Date(current.retention_event_at).valueOf() + Number(current.retention_duration_days) * 86_400_000) : null;
      const nextEnd = incoming.retention_mode === 'retain-until' ? incoming.retain_until : incoming.retention_mode === 'event' && incoming.retention_event_at && incoming.retention_duration_days != null ? new Date(new Date(incoming.retention_event_at).valueOf() + Number(incoming.retention_duration_days) * 86_400_000) : null;
      if (current.record_lock_type === 'policy' && (!oldEnd || !nextEnd || new Date(nextEnd) < new Date(oldEnd))) return { applied: false, file: current };
      const updated = (await client.query(`UPDATE files SET versioning_enabled=$2,major_minor_enabled=$3,require_approval=$4,require_checkout=$5,
        checked_out_by_user_id=$6,checked_out_by_device_id=$7,checked_out_at=$8,retention_mode=$9,retain_until=$10,retention_event_type=$11,
        retention_event_at=$12,retention_duration_days=$13,record_lock_type=$14,record_locked_at=$15,record_locked_by=$16,
        disposal_status=$17,disposal_review_at=$18,disposal_extended_until=$19,lifecycle_generation=$20,updated_at=NOW() WHERE id=$1 RETURNING *`,
      [current.id, Boolean(incoming.versioning_enabled), Boolean(incoming.major_minor_enabled), Boolean(incoming.require_approval), Boolean(incoming.require_checkout),
        incoming.checked_out_by_user_id ?? null, incoming.checked_out_by_device_id ?? null, incoming.checked_out_at ?? null, incoming.retention_mode,
        incoming.retain_until ?? null, incoming.retention_event_type ?? null, incoming.retention_event_at ?? null, incoming.retention_duration_days ?? null,
        incoming.record_lock_type, incoming.record_locked_at ?? null, incoming.record_locked_by ?? null, incoming.disposal_status,
        incoming.disposal_review_at ?? null, incoming.disposal_extended_until ?? null, generation])).rows[0];
      await journalLifecycle(client, updated); return { applied: true, file: updated };
    });
    if (result.applied) await deps.audit(request, 'lifecycle-sync', result.file); response.json({ applied: result.applied, generation: result.file.lifecycle_generation });
  } catch (error) { next(error) } });
  app.delete('/v1/trash/:id/purge', async(request:RequestWithIdentity, response, next) => { try {
    await deps.requireFile(request, request.params.id, 'manage'); const actor = deps.identity(request);
    const removed = await transaction(async client => {
      const file = await locked(client, request.params.id);
      if (!file.deleted_at) throw httpError(409, 'only trashed files can be purged');
      const expectedRevision=String(request.body?.expectedRevision??''); const expectedTombstone=String(request.body?.currentTombstone?.id??'');
      if (!/^\d+$/.test(expectedRevision) || expectedRevision!==String(file.operation_revision) || expectedTombstone!==String(file.current_version_id)) throw httpError(409,'Trash changed; refresh before permanent disposal');
      const active = (await client.query('SELECT files_retention_active(f) active FROM files f WHERE id=$1', [file.id])).rows[0]?.active;
      if (active || file.disposal_status !== 'approved') throw httpError(409, 'approved disposal with no active retention or lock is required');
      if ((await client.query('SELECT 1 FROM file_share_links WHERE file_id=$1 AND revoked_at IS NULL LIMIT 1', [file.id])).rowCount) throw httpError(409, 'active share links must be revoked before disposal');
      const receipt=(await client.query(`SELECT * FROM files_database_operation_receipts WHERE file_id=$1 AND action='trash' AND after_state->>'versionId'=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[file.id,file.current_version_id])).rows[0];
      let retained=false;
      if (receipt?.state==='completed') {
        if (request.body?.invalidateUndo!==true) throw httpError(409,'Permanent disposal must explicitly invalidate the retained Trash receipt');
        const operation=(await client.query('SELECT * FROM files_path_operations WHERE operation_id=$1 FOR UPDATE',[receipt.id])).rows[0];
        if (operation && (!['completed','undone','rolled-back'].includes(operation.state) || operation.last_error)) throw httpError(409,'Native Trash journal requires recovery before disposal');
        if (operation && !deps.disposeTrashReceipt) throw httpError(503,'Native retained-artifact disposal is unavailable; artifacts were preserved');
        const invalidation={undoInvalidatedAt:new Date().toISOString(),invalidatedBy:actor.userId,reason:'explicit-disposal'};
        const receiptPlan=receipt.folder_plan??{}; receiptPlan.lifecycle={...(receiptPlan.lifecycle??{}),disposal:invalidation};
        await client.query('UPDATE files_database_operation_receipts SET folder_plan=$2 WHERE id=$1',[receipt.id,receiptPlan]);
        if (operation) { const plan=operation.plan; plan.disposal=invalidation; await client.query('UPDATE files_path_operations SET plan=$2,updated_at=NOW() WHERE operation_id=$1',[receipt.id,plan]); retained=true }
      }
      await client.query('LOCK TABLE file_versions IN SHARE ROW EXCLUSIVE MODE');
      const chunks = await client.query(`SELECT DISTINCT v.chunk_collection_id,jsonb_array_elements_text(m.chunk_ids) chunk_id
        FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.file_id=$1`, [file.id]);
      const versionIds = (await client.query('SELECT id::text FROM file_versions WHERE file_id=$1 ORDER BY created_at,id', [file.id])).rows.map(row => row.id);
      const audit = await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,action,details)
        VALUES($1,$2,$3,'disposal-purge',$4) RETURNING id`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, { fileId: file.id, collectionId: file.collection_id, path: file.path, versionIds, physicalChunkGc: chunks.rowCount ? 'pending' : 'not-required' }]);
      await client.query(`INSERT INTO file_purge_tombstones(collection_id,file_id,path,lifecycle_generation,audience)
        SELECT $1,$2,$3,$4,jsonb_build_object(
          'users',to_jsonb(ARRAY(SELECT DISTINCT principal FROM (
            SELECT owner_user_id principal FROM collections WHERE id=$1
            UNION SELECT principal_id FROM folder_shares WHERE collection_id=$1 AND principal_type='user' AND ($3=folder_path OR starts_with($3,folder_path||'/'))
            UNION SELECT principal_id FROM file_shares WHERE file_id=$2 AND principal_type='user') users)),
          'groups',to_jsonb(ARRAY(SELECT DISTINCT principal FROM (
            SELECT principal_id FROM folder_shares WHERE collection_id=$1 AND principal_type='group' AND ($3=folder_path OR starts_with($3,folder_path||'/'))
            UNION SELECT principal_id FROM file_shares WHERE file_id=$2 AND principal_type='group') groups)))
        ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,lifecycle_generation=GREATEST(file_purge_tombstones.lifecycle_generation,EXCLUDED.lifecycle_generation),audience=EXCLUDED.audience,purged_at=NOW()`, [file.collection_id, file.id, file.path, Number(file.lifecycle_generation) + 1]);
      await client.query('DELETE FROM journal WHERE file_id=$1', [file.id]);
      await client.query('UPDATE audit_log SET file_id=NULL,version_id=NULL WHERE file_id=$1 OR version_id IN(SELECT id FROM file_versions WHERE file_id=$1)', [file.id]);
      await client.query('DELETE FROM file_share_links WHERE file_id=$1', [file.id]);
      await client.query('UPDATE files SET current_version_id=NULL,draft_version_id=NULL,published_version_id=NULL WHERE id=$1', [file.id]);
      await client.query('DELETE FROM files WHERE id=$1', [file.id]);
      let queued = 0;
      for (const chunk of chunks.rows) {
        const refs = Number((await client.query(`SELECT COUNT(DISTINCT v.id)::int refs FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
          WHERE v.chunk_collection_id=$1 AND m.chunk_ids ? $2`, [chunk.chunk_collection_id, chunk.chunk_id])).rows[0].refs);
        await client.query('UPDATE chunks SET refcount=$3 WHERE collection_id=$1 AND id=$2', [chunk.chunk_collection_id, chunk.chunk_id, refs]);
        if (refs === 0) { await client.query(`INSERT INTO file_chunk_gc(collection_id,chunk_id,audit_id) VALUES($1,$2,$3) ON CONFLICT(collection_id,chunk_id) DO UPDATE SET audit_id=EXCLUDED.audit_id,requested_at=NOW(),last_error=NULL`, [chunk.chunk_collection_id, chunk.chunk_id, audit.rows[0].id]); queued++ }
      }
      if (!queued) await client.query(`UPDATE audit_log SET details=jsonb_set(details,'{physicalChunkGc}',to_jsonb('not-required'::text),TRUE) WHERE id=$1`, [audit.rows[0].id]);
      return { auditId:audit.rows[0].id,queued,receiptId:receipt?.id??null,retained,id:file.id,path:file.path,revision:String(file.operation_revision) };
    });
    const retainedResult=removed.retained&&removed.receiptId
      ? await deps.disposeTrashReceipt!(removed.receiptId).catch(() => ({state:'recovery-required' as const,error:'Retained-artifact cleanup did not complete; exact artifacts were preserved for recovery'}))
      : {state:'none' as const};
    if (removed.queued) await drainPendingChunkGc(db, deps.deleteChunk).catch(() => undefined);
    const chunksPending=Boolean((await db.query('SELECT 1 FROM file_chunk_gc WHERE audit_id=$1 LIMIT 1',[removed.auditId])).rowCount);
    const common={kind:'file',id:removed.id,path:removed.path,revision:removed.revision,currentTombstone:null,metadataPurged:true};
    if (chunksPending || retainedResult.state==='recovery-required') return response.status(202).json({status:'recovery-required',...common,
      chunks:chunksPending?'pending':'complete',retainedArtifacts:retainedResult.state==='recovery-required'?'preserved':'complete',undo:removed.receiptId?'invalidated':'unavailable',receiptId:removed.receiptId,
      ...(retainedResult.error?{reason:retainedResult.error}:{})});
    response.json({status:'purged',...common,chunks:'complete',retainedArtifacts:retainedResult.state,undo:removed.receiptId?'invalidated':'unavailable',receiptId:removed.receiptId});
  } catch (error) { next(error) } });
}
