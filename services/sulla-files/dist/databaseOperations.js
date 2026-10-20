import { assertUnprotectedFile, isProtectedPath, protectedPathError } from './protectedFiles.js';
/** In-process authority only: Symbol keys cannot arrive over JSON or persist in receipt JSONB. */
export const folderGrantMigration = Symbol('folderGrantMigration');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const scope = (actor) => JSON.stringify([actor.kind, actor.deviceId, actor.agentId ?? '', actor.jobId ?? '', actor.threadId ?? '']);
const snapshot = (file) => ({
    collectionId: file.collection_id,
    fileId: file.id, path: file.path, versionId: file.current_version_id,
    revision: String(file.operation_revision), deleted: Boolean(file.deleted_at),
});
const receipt = (row) => ({
    operationId: row.id, collectionId: row.collection_id, action: row.action, state: row.state,
    undoSupported: row.state === 'completed', before: row.before_state, after: row.after_state,
    createdAt: row.created_at.toISOString(), undoneAt: row.undone_at?.toISOString() ?? null,
    ...(row.displaced_before ? { displacedBefore: row.displaced_before, displacedAfter: row.displaced_after } : {}),
});
export async function configuredReceiptLifecycle(client, collectionId, deletedAt) {
    const policy = (await client.query('SELECT retention_policy FROM collections WHERE id=$1', [collectionId])).rows[0]?.retention_policy;
    const days = Number(policy?.trashDays);
    if (!Number.isInteger(days) || days < 0)
        return {};
    return { expiresAt: new Date(deletedAt.valueOf() + days * 86_400_000).toISOString() };
}
export function parseDatabaseOperation(value) {
    if (!value || !['move', 'copy', 'rename', 'trash'].includes(value.action))
        throw fail(422, 'Unsupported database operation');
    for (const key of ['idempotencyKey', 'collectionId', 'fileId', 'expectedVersionId']) {
        if (typeof value[key] !== 'string' || !uuid.test(value[key]))
            throw fail(400, key + ' must be a UUID');
    }
    if (value.targetCollectionId !== undefined && (typeof value.targetCollectionId !== 'string' || !uuid.test(value.targetCollectionId) || !['move', 'copy'].includes(value.action)))
        throw fail(400, 'Only move/copy accept a UUID targetCollectionId');
    if (typeof value.expectedRevision !== 'string' || !/^[0-9]+$/.test(value.expectedRevision))
        throw fail(400, 'expectedRevision must be the file operation_revision string');
    if (value.collisionPolicy !== undefined && !['replace', 'keep-both', 'skip'].includes(value.collisionPolicy))
        throw fail(422, 'Unsupported collision policy');
    if (value.collisionPolicy === 'replace' && (!value.expectedDestination || !uuid.test(value.expectedDestination.fileId) || !uuid.test(value.expectedDestination.versionId) ||
        typeof value.expectedDestination.path !== 'string' || value.expectedDestination.path !== value.targetPath || !/^[0-9]+$/.test(value.expectedDestination.revision) || value.expectedDestination.deleted !== false ||
        (value.expectedDestination.collectionId !== undefined && (!uuid.test(value.expectedDestination.collectionId) || value.expectedDestination.collectionId !== (value.targetCollectionId ?? value.collectionId))))) {
        throw fail(400, 'Replace requires the displayed destination collection, identity, path, version and revision');
    }
    if (value.action !== 'trash' && (typeof value.targetPath !== 'string' || !value.targetPath || value.targetPath.includes('\\') ||
        value.targetPath.includes('\0') || value.targetPath.split('/').some((part) => !part || part === '.' || part === '..' || part === '.sulla-trash' || part === '.sulla-operation-recovery')))
        throw fail(400, 'targetPath must be a canonical relative Files path');
    if (value.action === 'trash' && (value.targetPath !== undefined || value.collisionPolicy !== undefined))
        throw fail(400, 'Trash does not accept a destination or collision policy');
    return {
        idempotencyKey: value.idempotencyKey.toLowerCase(), collectionId: value.collectionId.toLowerCase(),
        fileId: value.fileId.toLowerCase(), expectedVersionId: value.expectedVersionId.toLowerCase(),
        expectedRevision: value.expectedRevision, action: value.action,
        ...(value.targetCollectionId ? { targetCollectionId: value.targetCollectionId.toLowerCase() } : {}),
        ...(value.action === 'trash' ? {} : { targetPath: value.targetPath, collisionPolicy: value.collisionPolicy }),
        ...(value.expectedDestination ? { expectedDestination: value.expectedDestination } : {}),
    };
}
export async function transaction(db, run) {
    const client = await db.connect();
    let commitAttempted = false;
    let committed = false;
    try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='15s'");
        // Namespace triggers serialize legacy writers per collection. SERIALIZABLE
        // protects ACL/custody predicates without a service-wide lock across the
        // operation. External identity membership is prepared before BEGIN.
        const result = await run(client);
        commitAttempted = true;
        await client.query('COMMIT');
        committed = true;
        return result;
    }
    catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (['40001', '40P01', '23505', '55P03', '57014'].includes(error?.code))
            throw fail(409, 'Files changed concurrently or are busy; refresh before retrying. Receipt requests must reuse their idempotency key');
        throw error;
    }
    finally {
        client.release(commitAttempted && !committed);
    }
}
export async function lockedFile(client, id, access) {
    const row = (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row)
        throw fail(409, 'The file no longer exists');
    await assertUnprotectedFile(client, row);
    await access.file(client, id);
    const native = await client.query(`SELECT 1 FROM file_roots WHERE collection_id=$1
    UNION ALL SELECT 1 FROM watched_folder_state WHERE file_id=$2 LIMIT 1`, [row.collection_id, id]);
    if (native.rowCount && !access.custody)
        throw Object.assign(fail(422, 'Native Files receipt and undo are unsupported; a custody-coordinated native operation is required'), { code: 'native-custody-required' });
    return row;
}
function editable(file, actor) {
    if (file.record_lock_type !== 'none')
        throw fail(423, 'The record is locked');
    if (file.checked_out_by_user_id && (file.checked_out_by_user_id !== actor.userId ||
        (file.checked_out_by_device_id && file.checked_out_by_device_id !== (actor.deviceId || 'server-web'))))
        throw fail(409, 'The file is checked out by another editor');
    if (file.require_checkout && !file.checked_out_by_user_id)
        throw fail(409, 'The file must be checked out first');
}
async function journal(client, actor, file, op, operationId) {
    await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)', [file.collection_id, file.id, file.current_version_id, op]);
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, file.id, file.current_version_id, 'database-operation-' + op, { operationId }]);
}
export async function permissionBoundary(client, collectionId, from, to) {
    // Moving across inherited grant/public-link boundaries can expose content to
    // new readers. Stage one refuses that transition; direct file grants stay put.
    const changed = await client.query(`SELECT 1 FROM folder_shares WHERE collection_id=$1 AND
    (($2=folder_path OR starts_with($2,folder_path||'/')) IS DISTINCT FROM ($3=folder_path OR starts_with($3,folder_path||'/')))
    UNION ALL SELECT 1 FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND revoked_at IS NULL AND
    (($2=folder_path OR starts_with($2,folder_path||'/')) IS DISTINCT FROM ($3=folder_path OR starts_with($3,folder_path||'/'))) LIMIT 1`, [collectionId, from, to]);
    if (changed.rowCount)
        throw fail(422, 'Moving across folder permission boundaries is not supported by this receipt API');
}
export async function crossCollectionBoundary(client, source, target, actor, input) {
    const deny = (message = 'Cross-collection transfer changes the authorized audience') => Object.assign(fail(422, message), { code: 'cross-collection-boundary' });
    const rows = (await client.query('SELECT id,owner_user_id,kind FROM collections WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [[source, target]])).rows;
    if (rows.length !== 2 || rows.some(r => r.owner_user_id !== actor.userId || r.kind === 'scratch') || rows[0].kind !== rows[1].kind)
        throw deny();
    const grants = async (id, path) => (await client.query(`SELECT principal_type,principal_id,role FROM (
      SELECT principal_type,principal_id,role FROM collection_acl WHERE collection_id=$1
      UNION SELECT principal_type,principal_id,role FROM folder_shares WHERE collection_id=$1 AND $2::text IS NOT NULL
        AND ($2=folder_path OR starts_with($2,folder_path||'/'))
    ) audience ORDER BY principal_type,principal_id,role`, [id, path ?? null])).rows;
    if (JSON.stringify(await grants(source, input?.sourcePath)) !== JSON.stringify(await grants(target, input?.targetPath)))
        throw deny();
    if ((await client.query(`SELECT 1 FROM file_share_links WHERE revoked_at IS NULL AND
    ((collection_id=$1 AND folder_path IS NOT NULL AND $3::text IS NOT NULL AND ($3=folder_path OR starts_with($3,folder_path||'/')))
      OR (collection_id=$2 AND folder_path IS NOT NULL AND $4::text IS NOT NULL AND ($4=folder_path OR starts_with($4,folder_path||'/')))) LIMIT 1`, [source, target, input?.sourcePath ?? null, input?.targetPath ?? null])).rowCount)
        throw deny('Cross-collection folders with active public links cannot be transferred');
    const fileIds = input?.fileIds ?? [];
    if (fileIds.length) {
        const badContext = await client.query(`SELECT 1 FROM file_versions v LEFT JOIN file_version_key_contexts k ON k.version_id=v.id
      LEFT JOIN files_collection_key_bundles b ON b.collection_id=k.collection_id AND b.principal_id=k.principal_id
        AND b.key_version=k.key_version AND b.key_epoch=k.key_epoch
      WHERE v.file_id=ANY($1::uuid[]) AND k.version_id IS NOT NULL
        AND (k.principal_id<>$2 OR b.collection_id IS NULL) LIMIT 1`, [fileIds, actor.userId]);
        if (badContext.rowCount)
            throw Object.assign(fail(422, 'Cross-collection version key context is not recoverable for the current owner'), { code: 'cross-collection-key-boundary' });
    }
}
export async function permissionSignature(client, collectionId, operationId) {
    const target = (await client.query("SELECT request->>'targetCollectionId' AS id FROM files_database_operation_receipts WHERE id=$1", [operationId])).rows[0]?.id;
    const collections = [...new Set([collectionId, target].filter(Boolean))].sort();
    return (await client.query(`SELECT md5(jsonb_build_array(
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY collection_id,principal_type,principal_id),'[]') FROM collection_acl a WHERE collection_id=ANY($1::uuid[])),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY collection_id,id),'[]') FROM folder_shares a WHERE collection_id=ANY($1::uuid[])),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM file_shares a WHERE a.file_id::text IN
      (SELECT unnest(ARRAY[before_state->>'fileId',after_state->>'fileId',displaced_after->>'fileId']) FROM files_database_operation_receipts WHERE id=$2)),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM file_share_links a WHERE collection_id=ANY($1::uuid[])
      OR file_id::text IN (SELECT unnest(ARRAY[before_state->>'fileId',after_state->>'fileId',displaced_after->>'fileId']) FROM files_database_operation_receipts WHERE id=$2)))::text) AS signature`, [collections, operationId])).rows[0].signature;
}
async function copyReceiptFile(client, source, target, actor, destinationCollection = source.collection_id) {
    const copied = (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,expires_at,
    versioning_enabled,major_minor_enabled,require_approval)
    VALUES($1,$2,'user',$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [destinationCollection, target, actor.userId, source.mime, source.size, source.expires_at, source.versioning_enabled, source.major_minor_enabled, source.require_approval])).rows[0];
    const ids = [...new Set([source.published_version_id, source.current_version_id].filter(Boolean))];
    let current;
    for (const id of ids) {
        const version = (await client.query(`SELECT v.*,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.file_id=$2 AND v.deleted=FALSE FOR SHARE OF v,m`, [id, source.id])).rows[0];
        if (!version)
            throw fail(409, 'Copy source version is unavailable');
        const next = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,publication_status,version_kind)
      VALUES($1,$2,$3,$4,'user',$5,'Copied document',$6,$7,$8) RETURNING id`, [copied.id, version.chunk_collection_id, version.manifest_hash, version.size, actor.userId, actor.deviceId || 'server-web', version.publication_status, version.version_kind])).rows[0];
        await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [version.chunk_collection_id, version.chunk_ids]);
        await client.query(`INSERT INTO file_version_key_contexts(version_id,collection_id,principal_id,key_version,key_epoch)
      SELECT $2,collection_id,principal_id,key_version,key_epoch FROM file_version_key_contexts WHERE version_id=$1`, [id, next.id]);
        if (id === source.current_version_id)
            current = next.id;
    }
    if (!current)
        throw fail(409, 'Copy source has no current version');
    await client.query(`INSERT INTO file_shares(file_id,principal_type,principal_id,role,created_by)
    SELECT $2,principal_type,principal_id,role,$3 FROM file_shares WHERE file_id=$1`, [source.id, copied.id, actor.userId]);
    return (await client.query(`UPDATE files SET current_version_id=$2,require_checkout=$3,
    retention_mode=$4,retain_until=$5,retention_event_type=$6,retention_event_at=$7,retention_duration_days=$8,
    disposal_status=$9,disposal_review_at=$10,disposal_extended_until=$11,
    checked_out_by_user_id=CASE WHEN $3 THEN $12 ELSE NULL END,
    checked_out_by_device_id=CASE WHEN $3 THEN $13 ELSE NULL END,
    checked_out_at=CASE WHEN $3 THEN NOW() ELSE NULL END WHERE id=$1 RETURNING *`, [copied.id, current, source.require_checkout, source.retention_mode, source.retain_until, source.retention_event_type,
        source.retention_event_at, source.retention_duration_days, source.disposal_status, source.disposal_review_at, source.disposal_extended_until, actor.userId, actor.deviceId || 'server-web'])).rows[0];
}
export async function executeDatabaseOperation(db, input, actor, access, guard, existingClient) {
    const persistedRequest = { ...input };
    delete persistedRequest[folderGrantMigration];
    if (!existingClient)
        await access.prepare?.(input.collectionId);
    const destinationCollection = input.targetCollectionId ?? input.collectionId;
    if (!existingClient && destinationCollection !== input.collectionId)
        await access.prepare?.(destinationCollection);
    const execute = async (client) => {
        if (guard)
            await guard(client);
        for (const id of [...new Set([input.collectionId, destinationCollection])].sort())
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + id]);
        if (destinationCollection !== input.collectionId)
            await crossCollectionBoundary(client, input.collectionId, destinationCollection, actor, { sourcePath: (await client.query('SELECT path FROM files WHERE id=$1', [input.fileId])).rows[0]?.path, targetPath: input.targetPath, fileIds: [input.fileId] });
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + input.collectionId]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([actor.userId, scope(actor), input.idempotencyKey])]);
        const prior = (await client.query(`SELECT *,request=$4::jsonb AS same_request FROM files_database_operation_receipts
      WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=$3 FOR UPDATE`, [actor.userId, scope(actor), input.idempotencyKey, JSON.stringify(input)])).rows[0];
        if (prior) {
            if (!prior.same_request)
                throw fail(409, 'The idempotency key was already used for a different request');
            await lockedFile(client, prior.file_id, access);
            return receipt(prior);
        }
        const file = await lockedFile(client, input.fileId, access);
        if (file.collection_id !== input.collectionId || file.current_version_id !== input.expectedVersionId ||
            String(file.operation_revision) !== input.expectedRevision || file.deleted_at)
            throw Object.assign(fail(409, 'The selected file changed; refresh Files'), { code: 'source-conflict' });
        editable(file, actor);
        if ((await client.query("SELECT 1 FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') LIMIT 1", [file.collection_id, file.path])).rowCount)
            throw fail(422, 'Folder-like entries require a folder custody operation');
        const before = snapshot(file);
        let updated = file;
        let skipped = false;
        // Reserve receipt identity within the same transaction; rollback removes it.
        const row = (await client.query(`INSERT INTO files_database_operation_receipts
      (actor_user_id,actor_scope,idempotency_key,request,collection_id,file_id,action,state,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,'completed',$8,$8) RETURNING *`, [actor.userId, scope(actor), input.idempotencyKey, persistedRequest, file.collection_id, file.id, input.action, before])).rows[0];
        if (input.action === 'trash') {
            const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
        VALUES($1,$2,$3,0,TRUE,'user',$4,'Moved to Trash',$5,$3) RETURNING id`, [file.id, file.collection_id, file.current_version_id, actor.userId, actor.deviceId || 'server-web'])).rows[0];
            updated = (await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, version.id])).rows[0];
        }
        else {
            let target = input.targetPath;
            if (isProtectedPath(target))
                throw protectedPathError();
            if (target === file.path && input.action !== 'copy' && destinationCollection === input.collectionId)
                throw fail(400, 'Destination must differ from source');
            await access.path(client, destinationCollection, target);
            if (!input[folderGrantMigration] && destinationCollection === file.collection_id)
                await permissionBoundary(client, file.collection_id, file.path, target);
            const ancestorFile = await client.query("SELECT 1 FROM files WHERE collection_id=$1 AND starts_with($2,path||'/') LIMIT 1", [destinationCollection, target]);
            if (ancestorFile.rowCount)
                throw fail(409, 'A file occupies an ancestor of the destination');
            const occupied = async (path) => Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))
        UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [destinationCollection, path])).rowCount) || Boolean(await access.custody?.occupied(destinationCollection, path));
            let replaceDestination;
            if (input.collisionPolicy === 'replace') {
                const destination = (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE', [destinationCollection, target])).rows[0];
                if (!destination || destination.deleted_at)
                    throw Object.assign(fail(409, 'The Replace destination changed'), { code: 'destination-conflict' });
                if (destination.id === file.id)
                    throw Object.assign(fail(409, 'Cannot Replace the source itself; choose Keep Both or Skip'), { code: 'destination-conflict', destination: snapshot(destination) });
                replaceDestination = await lockedFile(client, destination.id, access);
                editable(replaceDestination, actor);
                const expected = input.expectedDestination;
                if (replaceDestination.id !== expected.fileId || replaceDestination.collection_id !== (expected.collectionId ?? destinationCollection) ||
                    replaceDestination.current_version_id !== expected.versionId || String(replaceDestination.operation_revision) !== expected.revision ||
                    replaceDestination.path !== expected.path || replaceDestination.deleted_at) {
                    throw Object.assign(fail(409, 'The Replace destination changed'), { code: 'destination-conflict', destination: snapshot(replaceDestination) });
                }
            }
            if (await occupied(target)) {
                if (input.collisionPolicy === 'replace') {
                    if ((await client.query("SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1", [destinationCollection, target])).rowCount)
                        throw Object.assign(fail(409, 'A folder occupies the destination; choose Keep Both or Skip'), { code: 'destination-conflict' });
                    const destination = replaceDestination;
                    const slash = target.lastIndexOf('/');
                    const recoveryPath = target.slice(0, slash + 1) + '.replaced-' + row.id + '-' + target.slice(slash + 1);
                    if (await occupied(recoveryPath))
                        throw fail(409, 'Replace recovery path is occupied');
                    await access.path(client, destinationCollection, recoveryPath);
                    await permissionBoundary(client, destinationCollection, target, recoveryPath);
                    const displaced = (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [destination.id, recoveryPath])).rows[0];
                    await journal(client, actor, displaced, 'rename', row.id);
                    await client.query('UPDATE files_database_operation_receipts SET displaced_before=$2,displaced_after=$3 WHERE id=$1', [row.id, snapshot(destination), snapshot(displaced)]);
                }
                else if (input.collisionPolicy === 'skip')
                    skipped = true;
                else if (input.collisionPolicy === 'keep-both') {
                    const dot = target.lastIndexOf('.');
                    const slash = target.lastIndexOf('/');
                    const split = dot > slash + 1 ? dot : target.length;
                    let found = false;
                    for (let n = 2; n <= 1000; n++) {
                        const candidate = target.slice(0, split) + ' (' + n + ')' + target.slice(split);
                        if (!await occupied(candidate)) {
                            target = candidate;
                            found = true;
                            break;
                        }
                    }
                    if (!found)
                        throw fail(409, 'No Keep Both destination is available');
                }
                else {
                    const destination = (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2', [destinationCollection, target])).rows[0];
                    if (destination)
                        await access.file(client, destination.id);
                    throw Object.assign(fail(409, 'Destination already exists; choose Replace, Keep Both or Skip'), { code: 'destination-conflict', ...(destination ? { destination: snapshot(destination) } : {}) });
                }
            }
            if (!skipped) {
                await access.path(client, destinationCollection, target);
                if (!input[folderGrantMigration] && destinationCollection === file.collection_id)
                    await permissionBoundary(client, file.collection_id, file.path, target);
                if ((await client.query("SELECT 1 FROM files WHERE collection_id=$1 AND starts_with($2,path||'/') LIMIT 1", [destinationCollection, target])).rowCount)
                    throw fail(409, 'A file occupies an ancestor of the destination');
                if (input.action === 'copy') {
                    updated = await copyReceiptFile(client, file, target, actor, destinationCollection);
                }
                else
                    updated = (await client.query('UPDATE files SET path=$2,collection_id=$3,updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, target, destinationCollection])).rows[0];
            }
        }
        if (!skipped)
            await journal(client, actor, updated, input.action === 'trash' ? 'delete' : input.action === 'copy' ? 'put' : 'rename', row.id);
        const receiptPlan = input.action === 'trash' && !skipped
            ? { lifecycle: await configuredReceiptLifecycle(client, file.collection_id, new Date(updated.deleted_at)) }
            : null;
        await client.query('UPDATE files_database_operation_receipts SET after_state=$2,state=$3,folder_plan=COALESCE(folder_plan,$4) WHERE id=$1', [row.id, snapshot(updated), skipped ? 'skipped' : 'completed', receiptPlan]);
        const committed = (await client.query('UPDATE files_database_operation_receipts SET permission_signature=$2 WHERE id=$1 RETURNING *', [row.id, await permissionSignature(client, input.collectionId, row.id)])).rows[0];
        if (!skipped)
            await access.custody?.publish(client, committed, false);
        return receipt(committed);
    };
    return existingClient ? execute(existingClient) : transaction(db, execute);
}
export async function undoDatabaseOperation(db, operationId, actor, access, guard, existingClient, internal) {
    if (!uuid.test(operationId))
        throw fail(400, 'operationId must be a UUID');
    const collection = (await (existingClient ?? db).query('SELECT collection_id,request FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3', [operationId, actor.userId, scope(actor)])).rows[0];
    if (collection && !existingClient)
        await access.prepare?.(collection.collection_id);
    if (collection?.request.targetCollectionId && !existingClient)
        await access.prepare?.(collection.request.targetCollectionId);
    const execute = async (client) => {
        if (guard)
            await guard(client);
        const row = (await client.query('SELECT * FROM files_database_operation_receipts WHERE id=$1 AND actor_user_id=$2 AND actor_scope=$3 FOR UPDATE', [operationId, actor.userId, scope(actor)])).rows[0];
        if (!row)
            throw fail(404, 'Database operation receipt not found; native undo is unsupported');
        if (row.folder_plan?.lifecycle?.disposal?.undoInvalidatedAt)
            throw fail(409, 'Undo was explicitly invalidated by permanent disposal');
        if (row.request.targetCollectionId && row.request.targetCollectionId !== row.collection_id) {
            await crossCollectionBoundary(client, row.collection_id, row.request.targetCollectionId, actor, { sourcePath: row.before_state?.path, targetPath: row.after_state?.path, fileIds: [row.before_state?.fileId].filter(Boolean) });
        }
        for (const id of [...new Set([row.collection_id, row.request.targetCollectionId].filter(Boolean))].sort())
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + id]);
        if (!internal?.permissionSignatureVerified && row.state === 'completed' && row.permission_signature && row.permission_signature !== await permissionSignature(client, row.collection_id, row.id))
            throw fail(409, 'Permissions or public links changed after the operation');
        if (row.action === 'create-folder') {
            await access.path(client, row.collection_id, row.after_state?.path ?? row.request.targetPath);
            if (row.state === 'undone')
                return receipt(row);
            if (row.state !== 'completed')
                throw fail(409, 'Skipped folders cannot be undone');
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + row.collection_id]);
            const folder = (await client.query('SELECT * FROM file_folders WHERE id=$1 FOR UPDATE', [row.after_state.folderId])).rows[0];
            if (!folder || folder.path !== row.after_state.path || String(folder.operation_revision) !== row.after_state.revision)
                throw fail(409, 'Folder changed after creation');
            const occupied = await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))
        UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND starts_with(path,$2||'/')
        UNION ALL SELECT 1 FROM folder_shares WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))
        UNION ALL SELECT 1 FROM file_share_links WHERE collection_id=$1 AND (folder_path=$2 OR starts_with(folder_path,$2||'/')) LIMIT 1`, [row.collection_id, folder.path]);
            if (occupied.rowCount)
                throw fail(409, 'Folder acquired children or grants; undo refused');
            await client.query('DELETE FROM file_folders WHERE id=$1', [folder.id]);
            await access.custody?.publish(client, row, true);
            await client.query(`INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user',$1,'undo-create-folder',$2)`, [actor.userId, { operationId, collectionId: row.collection_id, path: folder.path }]);
            return receipt((await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1 RETURNING *", [row.id])).rows[0]);
        }
        const file = await lockedFile(client, row.after_state.fileId, access);
        if (row.state === 'undone')
            return receipt(row);
        if (row.state !== 'completed')
            throw fail(409, 'Skipped operations cannot be undone');
        const expected = row.after_state;
        const before = row.before_state;
        if (JSON.stringify(snapshot(file)) !== JSON.stringify({
            collectionId: expected.collectionId ?? row.collection_id, fileId: expected.fileId, path: expected.path, versionId: expected.versionId, revision: expected.revision, deleted: expected.deleted,
        }))
            throw fail(409, 'Undo refused because the file changed after the operation');
        editable(file, actor);
        await access.path(client, before.collectionId ?? row.collection_id, before.path);
        if (!internal?.folderGrantMigration && file.collection_id === (before.collectionId ?? row.collection_id))
            await permissionBoundary(client, file.collection_id, file.path, before.path);
        if (row.action !== 'copy' && (await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND id<>$3
      AND (path=$2 OR starts_with(path,$2||'/') OR starts_with($2,path||'/')) LIMIT 1`, [before.collectionId ?? row.collection_id, before.path, file.id])).rowCount)
            throw fail(409, 'Undo destination is occupied');
        let updated;
        if (row.action === 'copy') {
            const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,deleted,created_by_type,created_by_id,message,device_id)
        VALUES($1,$2,$3,0,TRUE,'user',$4,'Undo copy',$5) RETURNING id`, [file.id, file.collection_id, file.current_version_id, actor.userId, actor.deviceId || 'server-web'])).rows[0];
            const recoveryPath = file.path + '.undone-' + row.id;
            await access.path(client, file.collection_id, recoveryPath);
            await permissionBoundary(client, file.collection_id, file.path, recoveryPath);
            updated = (await client.query('UPDATE files SET path=$2,current_version_id=$3,deleted_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, recoveryPath, version.id])).rows[0];
        }
        else if (row.action === 'trash') {
            const source = (await client.query(`SELECT v.id FROM file_versions v JOIN file_versions tombstone ON tombstone.id=$2 AND tombstone.file_id=v.file_id
        WHERE v.id=$1 AND v.file_id=$3 AND v.deleted=FALSE AND tombstone.deleted=TRUE AND tombstone.parent_version_id=v.id FOR SHARE OF v,tombstone`, [before.versionId, expected.versionId, file.id])).rows[0];
            if (!source)
                throw fail(409, 'Undo source version is no longer available');
            // Trash did not change publication pointers/statuses; restore that exact
            // parent while retaining the tombstone and all history.
            updated = (await client.query('UPDATE files SET current_version_id=$2,deleted_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, before.versionId])).rows[0];
        }
        else
            updated = (await client.query('UPDATE files SET path=$2,collection_id=$3,updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, before.path, before.collectionId ?? row.collection_id])).rows[0];
        if (row.displaced_before) {
            const displaced = await lockedFile(client, row.displaced_after.fileId, access);
            const expectedDisplaced = row.displaced_after;
            if (displaced.path !== expectedDisplaced.path || displaced.current_version_id !== expectedDisplaced.versionId || String(displaced.operation_revision) !== expectedDisplaced.revision || Boolean(displaced.deleted_at) !== expectedDisplaced.deleted)
                throw fail(409, 'The displaced file changed; undo refused');
            editable(displaced, actor);
            await access.path(client, displaced.collection_id, row.displaced_before.path);
            if (!internal?.folderGrantMigration)
                await permissionBoundary(client, displaced.collection_id, displaced.path, row.displaced_before.path);
            const restored = (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [displaced.id, row.displaced_before.path])).rows[0];
            await journal(client, actor, restored, 'rename', row.id);
        }
        await journal(client, actor, updated, row.action === 'trash' ? 'restore' : row.action === 'copy' ? 'delete' : 'rename', row.id);
        await access.custody?.publish(client, row, true);
        return receipt((await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1 RETURNING *", [row.id])).rows[0]);
    };
    return existingClient ? execute(existingClient) : transaction(db, execute);
}
export async function createDatabaseFolder(db, input, actor, access, guard) {
    await access.prepare?.(input.collectionId);
    return transaction(db, async (client) => {
        await guard(client);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['stored-namespace:' + input.collectionId]);
        await access.path(client, input.collectionId, input.targetPath);
        const prior = (await client.query('SELECT * FROM files_database_operation_receipts WHERE actor_user_id=$1 AND actor_scope=$2 AND idempotency_key=$3', [actor.userId, scope(actor), input.idempotencyKey])).rows[0];
        if (prior)
            return receipt(prior);
        if (!access.custody && (await client.query('SELECT 1 FROM file_roots WHERE collection_id=$1', [input.collectionId])).rowCount)
            throw Object.assign(fail(422, 'Native folders require custody'), { code: 'native-custody-required' });
        const occupied = async (path) => Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [input.collectionId, path])).rowCount) || Boolean(await access.custody?.occupied(input.collectionId, path));
        let path = input.targetPath;
        let skipped = false;
        if (await occupied(path)) {
            if (input.collisionPolicy === 'skip')
                skipped = true;
            else if (input.collisionPolicy === 'keep-both') {
                let n = 2;
                while (await occupied(path) && n <= 1000)
                    path = input.targetPath + ' (' + n++ + ')';
                if (await occupied(path))
                    throw fail(409, 'No Keep Both folder destination available');
            }
            else
                throw Object.assign(fail(409, 'Folder destination exists'), { code: 'destination-conflict' });
        }
        await access.path(client, input.collectionId, path);
        let after = null;
        if (!skipped) {
            const folder = (await client.query(`INSERT INTO file_folders(collection_id,path,created_by_id) VALUES($1,$2,$3) RETURNING *`, [input.collectionId, path, actor.userId])).rows[0];
            after = { folderId: folder.id, path, revision: String(folder.operation_revision) };
        }
        const row = (await client.query(`INSERT INTO files_database_operation_receipts(actor_user_id,actor_scope,idempotency_key,request,collection_id,action,state,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,'create-folder',$6,'null'::jsonb,$7::jsonb) RETURNING *`, [actor.userId, scope(actor), input.idempotencyKey, input, input.collectionId, skipped ? 'skipped' : 'completed', JSON.stringify(after)])).rows[0];
        await client.query(`INSERT INTO audit_log(who_type,who_id,action,details) VALUES('user',$1,'create-folder',$2)`, [actor.userId, { operationId: row.id, collectionId: input.collectionId, path, skipped }]);
        if (!skipped)
            await access.custody?.publish(client, row, false);
        return receipt(row);
    });
}
/** Restore one exact Trash tombstone. Receipt restore never invokes its batch. */
export async function restoreTrashReceipt(client, row, actor, access, publish = true) {
    if (row.action !== 'trash' || row.state !== 'completed' || row.folder_plan?.source)
        throw fail(409, 'The Trash receipt is not available for file restore');
    if (row.folder_plan?.lifecycle?.disposal?.undoInvalidatedAt)
        throw fail(409, 'The retained Trash receipt expired or was explicitly invalidated');
    if (row.permission_signature && row.permission_signature !== await permissionSignature(client, row.collection_id, row.id))
        throw fail(409, 'Permissions or public links changed after Trash');
    const file = await lockedFile(client, row.file_id, access);
    const expected = row.after_state;
    const before = row.before_state;
    if (JSON.stringify(snapshot(file)) !== JSON.stringify({ collectionId: expected.collectionId ?? row.collection_id, fileId: expected.fileId, path: expected.path, versionId: expected.versionId, revision: expected.revision, deleted: expected.deleted })) {
        throw fail(409, 'The Trash tombstone changed; refresh Files');
    }
    editable(file, actor);
    await access.path(client, before.collectionId ?? row.collection_id, before.path);
    const source = (await client.query(`SELECT v.id FROM file_versions v JOIN file_versions tombstone ON tombstone.id=$2 AND tombstone.file_id=v.file_id
    WHERE v.id=$1 AND v.file_id=$3 AND v.deleted=FALSE AND tombstone.deleted=TRUE AND tombstone.parent_version_id=v.id FOR SHARE OF v,tombstone`, [before.versionId, expected.versionId, file.id])).rows[0];
    if (!source)
        throw fail(409, 'The exact pre-Trash version is no longer available');
    const updated = (await client.query('UPDATE files SET current_version_id=$2,deleted_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING *', [file.id, before.versionId])).rows[0];
    await journal(client, actor, updated, 'restore', row.id);
    if (publish)
        await access.custody?.publish(client, row, true);
    await client.query("UPDATE files_database_operation_receipts SET state='undone',undone_at=NOW() WHERE id=$1", [row.id]);
    return updated;
}
export async function restoreTrashedFile(db, fileId, actor, access, request = {}) {
    if (!uuid.test(fileId))
        throw fail(400, 'fileId must be a UUID');
    if (request.expectedVersionId !== undefined && (typeof request.expectedVersionId !== 'string' || !uuid.test(request.expectedVersionId)))
        throw fail(400, 'expectedVersionId must be a UUID');
    if (request.expectedRevision !== undefined && (typeof request.expectedRevision !== 'string' || !/^\d+$/.test(request.expectedRevision)))
        throw fail(400, 'expectedRevision must be a decimal string');
    if (request.receiptId !== undefined && (typeof request.receiptId !== 'string' || !uuid.test(request.receiptId)))
        throw fail(400, 'receiptId must be a UUID');
    const collection = (await db.query('SELECT collection_id FROM files WHERE id=$1', [fileId])).rows[0];
    if (collection)
        await access.prepare?.(collection.collection_id);
    const execute = () => transaction(db, async (client) => {
        const file = (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
        if (!file)
            throw fail(404, 'file not found');
        await access.file(client, fileId);
        if (!file.deleted_at || (request.expectedVersionId !== undefined && file.current_version_id !== request.expectedVersionId) ||
            (request.expectedRevision !== undefined && String(file.operation_revision) !== request.expectedRevision))
            throw fail(409, 'The trashed file changed; refresh Files');
        editable(file, actor);
        const tombstone = (await client.query('SELECT * FROM file_versions WHERE id=$1 AND file_id=$2 AND deleted=TRUE FOR UPDATE', [file.current_version_id, file.id])).rows[0];
        if (!tombstone)
            throw fail(409, 'The current version is not a trash tombstone');
        const native = Boolean((await client.query('SELECT 1 FROM file_roots WHERE collection_id=$1 LIMIT 1', [file.collection_id])).rowCount);
        const receiptRow = request.receiptId ? (await client.query(`SELECT * FROM files_database_operation_receipts WHERE id=$1 AND file_id=$2 AND action='trash' FOR UPDATE`, [request.receiptId, file.id])).rows[0] : null;
        if (request.receiptId && !receiptRow)
            throw fail(409, 'The selected Trash receipt does not match this file');
        if (receiptRow) {
            if (receiptRow.after_state?.versionId !== tombstone.id)
                throw fail(409, 'The selected Trash receipt is not the current tombstone');
            const updated = await restoreTrashReceipt(client, receiptRow, actor, access, true);
            return { status: 'restored', kind: 'file', id: updated.id, path: updated.path, revision: String(updated.operation_revision), currentTombstone: null, receiptId: receiptRow.id, versionId: updated.current_version_id };
        }
        if (native)
            throw Object.assign(fail(409, 'Native Trash Restore requires its exact retained receipt'), { code: 'trash-receipt-required' });
        // Follow the locked tombstone lineage, never select an unrelated newer
        // draft/version by timestamp. UNION also terminates malformed cycles.
        const source = (await client.query(`WITH RECURSIVE lineage AS (
      SELECT id,parent_version_id,deleted FROM file_versions WHERE id=$1 AND file_id=$2
      UNION SELECT v.id,v.parent_version_id,v.deleted FROM file_versions v JOIN lineage p ON v.id=p.parent_version_id
      WHERE p.deleted=TRUE AND v.file_id=$2)
      SELECT v.* FROM file_versions v JOIN lineage l ON l.id=v.id WHERE v.deleted=FALSE AND v.manifest_hash IS NOT NULL
      FOR UPDATE OF v`, [tombstone.parent_version_id, file.id])).rows[0];
        if (!source)
            throw fail(409, 'No restorable ancestor version remains');
        const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,manifest_hash,size,created_by_type,created_by_id,message,device_id,base_server_version_id)
      VALUES($1,$2,$3,$4,$5,'user',$6,'Restored from Trash',$7,$3) RETURNING id`, [file.id, source.chunk_collection_id, file.current_version_id, source.manifest_hash, source.size, actor.userId, actor.deviceId || 'server-web'])).rows[0];
        await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id IN (SELECT jsonb_array_elements_text(chunk_ids) FROM manifests WHERE hash=$2)', [source.chunk_collection_id, source.manifest_hash]);
        const updated = (await client.query(`UPDATE files SET current_version_id=$2,deleted_at=NULL,size=$3,updated_at=NOW()
      WHERE id=$1 AND current_version_id=$4 AND deleted_at IS NOT NULL RETURNING *`, [file.id, version.id, source.size, file.current_version_id])).rows[0];
        if (!updated)
            throw fail(409, 'The trash tombstone changed while restoring');
        await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'restore')", [file.collection_id, file.id, version.id]);
        await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES($1,$2,$3,$4,$5,'trash-restore',$6)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, file.id, version.id, { tombstoneVersionId: tombstone.id, sourceVersionId: source.id }]);
        return { status: 'restored', kind: 'file', id: updated.id, path: updated.path, revision: String(updated.operation_revision), currentTombstone: null, receiptId: null, versionId: version.id };
    });
    return access.custody ? access.custody.run(execute) : execute();
}
export async function trashFileWithoutReceipt(db, fileId, actor, access) {
    if (!uuid.test(fileId))
        throw fail(400, 'fileId must be a UUID');
    const collection = (await db.query('SELECT collection_id FROM files WHERE id=$1', [fileId])).rows[0];
    if (collection)
        await access.prepare?.(collection.collection_id);
    return transaction(db, async (client) => {
        const file = (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
        if (!file)
            throw fail(404, 'file not found');
        await access.file(client, fileId);
        if (file.deleted_at)
            throw fail(409, 'The file is already in Trash');
        editable(file, actor);
        const version = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,parent_version_id,size,deleted,created_by_type,created_by_id,message,device_id,base_server_version_id)
      VALUES($1,$2,$3,0,TRUE,'user',$4,'Moved to Trash',$5,$3) RETURNING id`, [file.id, file.collection_id, file.current_version_id, actor.userId, actor.deviceId || 'server-web'])).rows[0];
        await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [file.id, version.id]);
        await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'delete')", [file.collection_id, file.id, version.id]);
        await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES($1,$2,$3,$4,$5,'trash',$6)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, file.id, version.id, { parentVersionId: file.current_version_id }]);
    });
}
