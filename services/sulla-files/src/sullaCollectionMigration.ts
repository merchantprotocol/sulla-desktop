import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Config } from './config.js';
import { executeDatabaseOperation, type DatabaseOperationAccess } from './databaseOperations.js';

export interface SullaCollectionMigrationSummary { moved:number; skipped:number; collisions:number }
const actorFor = (config:Config) => ({ kind:'user' as const, userId:config.userId, deviceId:'sulla-files-migration' });
const access:DatabaseOperationAccess = {
  file: async(client,id) => (await client.query('SELECT * FROM files WHERE id=$1',[id])).rows[0],
  path: async() => undefined,
};
async function occupied(db:pg.Pool, collectionId:string, path:string):Promise<boolean> {
  return Boolean((await db.query(`SELECT 1 FROM files WHERE collection_id=$1 AND path=$2
    UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1`,[collectionId,path])).rowCount);
}
async function migratedPath(db:pg.Pool, collectionId:string, original:string):Promise<{path:string;collision:boolean}> {
  if (!await occupied(db,collectionId,original)) return {path:original,collision:false};
  const slash=original.lastIndexOf('/'); const leaf=original.slice(slash+1); const dot=leaf.lastIndexOf('.');
  const split=dot>0 ? slash+1+dot : original.length;
  for(let n=1;n<=1000;n++) {
    const label=n===1?' (migrated)':` (migrated ${n})`; const candidate=original.slice(0,split)+label+original.slice(split);
    if (!await occupied(db,collectionId,candidate)) return {path:candidate,collision:true};
  }
  throw new Error(`No migration destination is available for ${original}`);
}

/** Resumable retirement of the former Sulla collection into the owner's home collection. */
export async function migrateSullaCollection(db:pg.Pool, config:Config):Promise<SullaCollectionMigrationSummary> {
  const source=(await db.query("SELECT * FROM collections WHERE system_area='sulla' AND published=TRUE ORDER BY created_at LIMIT 1")).rows[0];
  if (!source) return {moved:0,skipped:0,collisions:0};
  const home=(await db.query(`SELECT * FROM collections WHERE owner_user_id=$1 AND published=TRUE AND legacy_source=FALSE
    AND system_area IS NULL ORDER BY is_default DESC,(explorer_path='') DESC,created_at LIMIT 1`,[source.owner_user_id])).rows[0];
  if (!home) throw new Error('Cannot migrate Sulla collection without an owner home collection');
  let moved=0,skipped=0,collisions=0;
  await db.query(`CREATE TABLE IF NOT EXISTS sulla_collection_migration_paths(source_collection_id UUID NOT NULL,source_path TEXT NOT NULL,target_path TEXT NOT NULL,PRIMARY KEY(source_collection_id,source_path))`);
  const folderMap=new Map<string,string>((await db.query('SELECT source_path,target_path FROM sulla_collection_migration_paths WHERE source_collection_id=$1',[source.id])).rows.map(row=>[row.source_path,row.target_path]));
  const folders=(await db.query('SELECT * FROM file_folders WHERE collection_id=$1 ORDER BY length(path),path',[source.id])).rows;
  for(const folder of folders) {
    const parent=[...folderMap.keys()].filter(path=>folder.path.startsWith(path+'/')).sort((a,b)=>b.length-a.length)[0];
    const proposed=parent ? folderMap.get(parent)!+folder.path.slice(parent.length) : folder.path;
    const recorded=folderMap.get(folder.path); const target=recorded ? {path:recorded,collision:recorded!==folder.path} : await migratedPath(db,home.id,proposed); folderMap.set(folder.path,target.path);
    await db.query('INSERT INTO sulla_collection_migration_paths(source_collection_id,source_path,target_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[source.id,folder.path,target.path]);
    if(target.collision) { collisions++; console.warn(`[SullaFiles] Sulla folder migration collision: ${folder.path} -> ${target.path}`) }
    await db.query(`UPDATE file_folders SET collection_id=$2,path=$3 WHERE id=$1 AND collection_id=$4`,[folder.id,home.id,target.path,source.id]);
  }
  const files=(await db.query('SELECT * FROM files WHERE collection_id=$1 ORDER BY created_at,id',[source.id])).rows;
  for (const file of files) {
    const parent=[...folderMap.keys()].filter(path=>file.path.startsWith(path+'/')).sort((a,b)=>b.length-a.length)[0];
    const proposed=parent ? folderMap.get(parent)!+file.path.slice(parent.length) : file.path;
    const target=await migratedPath(db,home.id,proposed); if(target.collision) { collisions++; console.warn(`[SullaFiles] Sulla migration collision: ${file.path} -> ${target.path}`) }
    if (file.deleted_at) {
      const client=await db.connect(); try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sulla-main-tree:${file.id}`]);
        const current=(await client.query('SELECT collection_id FROM files WHERE id=$1 FOR UPDATE',[file.id])).rows[0];
        if(current?.collection_id===source.id) { await client.query('UPDATE files SET collection_id=$2,path=$3 WHERE id=$1',[file.id,home.id,target.path]); moved++ } else skipped++;
        await client.query('COMMIT');
      } catch(error){await client.query('ROLLBACK');throw error} finally{client.release()}
    } else {
      await executeDatabaseOperation(db,{idempotencyKey:randomUUID(),collectionId:source.id,targetCollectionId:home.id,action:'move',fileId:file.id,
        expectedVersionId:file.current_version_id,expectedRevision:String(file.operation_revision),targetPath:target.path},actorFor(config),access);
      moved++;
    }
  }
  const remaining=Number((await db.query('SELECT count(*) AS count FROM files WHERE collection_id=$1',[source.id])).rows[0].count);
  const remainingFolders=Number((await db.query('SELECT count(*) AS count FROM file_folders WHERE collection_id=$1',[source.id])).rows[0].count);
  if (!remaining && !remainingFolders) await db.query("UPDATE collections SET published=FALSE,explorer_path='Sulla (retired)' WHERE id=$1",[source.id]);
  else throw new Error(`Sulla migration verification failed: ${remaining} files and ${remainingFolders} folders remain`);
  console.log(`[SullaFiles] Sulla migration complete: moved=${moved} skipped=${skipped} collisions=${collisions}`);
  return {moved,skipped,collisions};
}
