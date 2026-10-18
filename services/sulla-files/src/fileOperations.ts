import type { FilesIdentity } from './auth.js';
import type pg from 'pg';

export interface FileOperationItem { fileId?:string; folderPath?:string; targetPath:string }

export class FileOperationConflict extends Error { status = 409 }

async function assertAvailable(client:pg.PoolClient, collectionId:string, paths:string[]):Promise<void> {
  const existing = await client.query('SELECT path FROM files WHERE collection_id=$1 AND path=ANY($2::text[])', [collectionId, paths]);
  if (existing.rowCount) throw new FileOperationConflict(`A file already exists at ${ existing.rows[0].path }`);
}

export async function copyLockedFile(client:pg.PoolClient, source:any, targetPath:string, actor:FilesIdentity):Promise<any> {
  const version = (await client.query(`SELECT v.*,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash
    WHERE v.id=$1 AND NOT v.deleted`, [source.current_version_id])).rows[0];
  if (!version) throw Object.assign(new Error('The current version is not copyable'), { status: 409 });
  const inserted = (await client.query(`INSERT INTO files(collection_id,path,created_by_type,created_by_id,mime,size,extraction_status)
    VALUES($1,$2,'user',$3,$4,$5,'pending') RETURNING *`, [source.collection_id, targetPath, actor.userId, source.mime, source.size])).rows[0];
  const copiedVersion = (await client.query(`INSERT INTO file_versions(file_id,chunk_collection_id,manifest_hash,size,created_by_type,created_by_id,message,device_id)
    VALUES($1,$2,$3,$4,'user',$5,$6,$7) RETURNING id`, [inserted.id, version.chunk_collection_id, version.manifest_hash, version.size, actor.userId, `Copied from ${ source.path }`, actor.deviceId || 'server-web'])).rows[0];
  await client.query('UPDATE files SET current_version_id=$2 WHERE id=$1', [inserted.id, copiedVersion.id]);
  await client.query('UPDATE chunks SET refcount=refcount+1 WHERE collection_id=$1 AND id=ANY($2::text[])', [version.chunk_collection_id, version.chunk_ids]);
  await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'put')", [source.collection_id, inserted.id, copiedVersion.id]);
  await client.query("INSERT INTO file_index_jobs(file_id,version_id,status) VALUES($1,$2,'pending') ON CONFLICT(version_id) DO NOTHING", [inserted.id, copiedVersion.id]);
  return { ...inserted, current_version_id: copiedVersion.id };
}

export async function applyDatabaseFileOperations(db:pg.Pool, action:'move' | 'copy', sources:{ file:any; targetPath:string }[], actor:FilesIdentity, folderMoves:{ collectionId:string; sourcePath:string; targetPath:string }[] = []):Promise<any[]> {
  if (new Set(sources.map(source => source.targetPath)).size !== sources.length) throw new FileOperationConflict('Two selected items have the same destination');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked:any[] = [];
    for (const source of sources) {
      const row = (await client.query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [source.file.id])).rows[0];
      if (!row) throw Object.assign(new Error('A selected file is no longer available'), { status: 404 });
      if (row.collection_id !== source.file.collection_id || row.path !== source.file.path || row.current_version_id !== source.file.current_version_id) throw new FileOperationConflict('A selected file changed while the operation was starting. Refresh Files and try again.');
      locked.push({ file: row, targetPath: source.targetPath });
    }
    await assertAvailable(client, locked[0]?.file.collection_id, locked.map(item => item.targetPath));
    const results:any[] = [];
    for (const item of locked) {
      let result:any;
      if (action === 'copy') result = await copyLockedFile(client, item.file, item.targetPath, actor);
      else {
        result = (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [item.file.id, item.targetPath])).rows[0];
        await client.query('UPDATE watched_folder_state SET path=$2 WHERE file_id=$1', [item.file.id, item.targetPath]);
        await client.query("INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,'rename')", [item.file.collection_id, item.file.id, item.file.current_version_id]);
      }
      results.push(result);
      await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId, actor.deviceId || null, result.id, result.current_version_id, action, JSON.stringify({ collectionId: item.file.collection_id, from: item.file.path, to: item.targetPath })]);
    }
    if (action === 'move') {
      for (const folder of folderMoves) {
        for (const table of ['file_stars', 'folder_shares', 'file_share_links']) await client.query(`UPDATE ${ table } SET folder_path=$3||substr(folder_path,length($2)+1) WHERE collection_id=$1 AND folder_path IS NOT NULL AND (folder_path=$2 OR starts_with(folder_path,$2||'/'))`, [folder.collectionId, folder.sourcePath, folder.targetPath]);
      }
    }
    await client.query('COMMIT');
    return results;
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
