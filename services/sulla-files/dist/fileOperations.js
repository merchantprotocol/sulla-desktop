// SPDX-License-Identifier: GPL-2.0-or-later
import { assertStoredFilePath, assertStoredFolderPath, ensureStoredFileParents, ensureStoredFolder, lockStoredNamespace } from './storedNamespace.js';
export class FileOperationConflict extends Error {
    status = 409;
}
export async function copyLockedFile(client, source, targetPath, actor) {
    const version = (await client.query(`SELECT v.*,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
    WHERE v.id=$1 AND NOT v.deleted`, [source.copy_version_id ?? source.current_version_id])).rows[0];
    if (!version)
        throw Object.assign(new Error('The current version is not copyable'), { status: 409 });
    const inserted = (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,extraction_status)
    VALUES($1,$2,'user',$3,$4,$5,'pending') RETURNING *`, [source.collection_id, targetPath, actor.userId, source.mime, source.size])).rows[0];
    const copiedVersion = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,message,device_id)
    VALUES($1,$2,$3,$4,'user',$5,$6,$7) RETURNING id`, [inserted.id, version.chunk_collection_id, version.manifest_hash, version.size, actor.userId, `Copied from ${source.path}`, actor.deviceId || 'server-web'])).rows[0];
    await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [inserted.id, copiedVersion.id]);
    await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [version.chunk_collection_id, version.chunk_ids]);
    await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [source.collection_id, inserted.id, copiedVersion.id]);
    await client.query("INSERT INTO file_index_jobs(file_id,version_id,status) VALUES($1,$2,'pending') ON CONFLICT(version_id) DO NOTHING", [inserted.id, copiedVersion.id]);
    return { ...inserted, current_version_id: copiedVersion.id };
}
export async function applyDatabaseFileOperations(db, action, sources, actor, folderMoves = []) {
    if (new Set(sources.map(source => source.targetPath)).size !== sources.length)
        throw new FileOperationConflict('Two selected items have the same destination');
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const collectionId = sources[0]?.file.collection_id ?? folderMoves[0]?.collectionId;
        if (!collectionId)
            throw Object.assign(new Error('No stored Files items were selected'), { status: 404 });
        if (sources.some(source => source.file.collection_id !== collectionId) || folderMoves.some(folder => folder.collectionId !== collectionId)) {
            throw Object.assign(new Error('Stored Files operations must stay within one collection'), { status: 400 });
        }
        await lockStoredNamespace(client, collectionId);
        const locked = [];
        for (const source of sources) {
            const row = (await client.query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [source.file.id])).rows[0];
            if (!row)
                throw Object.assign(new Error('A selected file is no longer available'), { status: 404 });
            if (row.collection_id !== source.file.collection_id || row.path !== source.file.path || row.current_version_id !== source.file.current_version_id)
                throw new FileOperationConflict('A selected file changed while the operation was starting. Refresh Files and try again.');
            locked.push({ file: { ...row, copy_version_id: source.file.copy_version_id }, targetPath: source.targetPath });
        }
        const storedFolders = [];
        for (const folder of folderMoves) {
            const rows = await client.query(`SELECT path FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY path FOR UPDATE`, [folder.collectionId, folder.sourcePath]);
            if (!rows.rowCount && !sources.some(source => source.file.path.startsWith(`${folder.sourcePath}/`)))
                throw Object.assign(new Error('A selected folder is no longer available'), { status: 404 });
            if (!rows.rows.some(row => row.path === folder.sourcePath))
                rows.rows.unshift({ path: folder.sourcePath });
            for (const row of rows.rows)
                storedFolders.push({ collectionId: folder.collectionId, sourcePath: row.path, targetPath: `${folder.targetPath}${row.path.slice(folder.sourcePath.length)}` });
        }
        const targets = [...locked.map(item => item.targetPath), ...storedFolders.map(folder => folder.targetPath)];
        if (new Set(targets).size !== targets.length)
            throw new FileOperationConflict('Two selected items have the same destination');
        for (const item of locked)
            await assertStoredFilePath(client, collectionId, item.targetPath);
        for (const folder of storedFolders) {
            await assertStoredFolderPath(client, collectionId, folder.targetPath);
            const existing = await client.query('SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1', [collectionId, folder.targetPath]);
            if (existing.rowCount)
                throw new FileOperationConflict(`A folder already exists at ${folder.targetPath}`);
        }
        const results = [];
        for (const item of locked) {
            let result;
            if (action === 'copy')
                result = await copyLockedFile(client, item.file, item.targetPath, actor);
            else {
                result = (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [item.file.id, item.targetPath])).rows[0];
                await client.query('UPDATE watched_folder_state SET path=$2 WHERE file_id=$1', [item.file.id, item.targetPath]);
                await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'rename')", [item.file.collection_id, item.file.id, item.file.current_version_id]);
            }
            results.push(result);
            await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, result.id, result.current_version_id, action, JSON.stringify({ collectionId: item.file.collection_id, from: item.file.path, to: item.targetPath })]);
        }
        if (action === 'copy') {
            for (const folder of storedFolders)
                await ensureStoredFolder(client, folder.collectionId, folder.targetPath, actor);
        }
        else {
            for (const folder of [...storedFolders].sort((left, right) => right.sourcePath.length - left.sourcePath.length)) {
                await client.query('UPDATE file_folders SET path=$3,updated_at=NOW() WHERE collection_id=$1 AND path=$2', [folder.collectionId, folder.sourcePath, folder.targetPath]);
            }
            for (const folder of folderMoves) {
                for (const table of ['file_stars', 'folder_shares', 'file_share_links'])
                    await client.query(`UPDATE ${table} SET folder_path=$3||substr(folder_path,length($2)+1) WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))`, [folder.collectionId, folder.sourcePath, folder.targetPath]);
            }
            for (const folder of storedFolders)
                await ensureStoredFolder(client, folder.collectionId, folder.targetPath, actor);
        }
        for (const item of locked)
            await ensureStoredFileParents(client, collectionId, item.targetPath, actor);
        await client.query('COMMIT');
        return results;
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
    }
}
