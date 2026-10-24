import type pg from 'pg';
import type { Config } from './config.js';

export interface SullaCollectionMigrationSummary { moved:number; collisions:number }

const homeQuery = `SELECT * FROM collections WHERE owner_user_id=$1 AND published=TRUE AND legacy_source=FALSE
  AND system_area IS NULL ORDER BY EXISTS(SELECT 1 FROM collection_acl a WHERE a.collection_id=collections.id AND a.principal_type='user' AND a.principal_id=$1 AND a.role='manage') DESC,is_default DESC,created_at LIMIT 1`;

async function occupied(client:pg.PoolClient, collectionId:string, path:string):Promise<boolean> {
  return Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND path=$2
    UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1`,[collectionId,path])).rowCount);
}
async function freePath(client:pg.PoolClient, collectionId:string, original:string):Promise<{path:string;collision:boolean}> {
  if (!await occupied(client,collectionId,original)) return {path:original,collision:false};
  const slash=original.lastIndexOf('/'); const leaf=original.slice(slash+1); const dot=leaf.lastIndexOf('.');
  const split=dot>0 ? slash+1+dot : original.length;
  for(let n=1;n<=1000;n++) {
    const candidate=original.slice(0,split)+(n===1?' (migrated)':` (migrated ${n})`)+original.slice(split);
    if (!await occupied(client,collectionId,candidate)) return {path:candidate,collision:true};
  }
  throw new Error(`No migration destination is available for ${original}`);
}

/**
 * Moves every folder and file of the former Sulla system collection into the owner's home collection.
 * Content is not re-encrypted: each version keeps its chunk_collection_id, so the Sulla collection
 * (and its key) must stay published. It is emptied and renamed, never deleted.
 */
export async function migrateSullaCollection(db:pg.Pool, config:Config):Promise<SullaCollectionMigrationSummary> {
  const source=(await db.query("SELECT * FROM collections WHERE system_area='sulla' LIMIT 1")).rows[0];
  if (!source) return {moved:0,collisions:0};
  const home=(await db.query(homeQuery,[source.owner_user_id])).rows[0];
  if (!home) throw new Error('Cannot migrate the Sulla collection without an owner home collection');
  await db.query(`CREATE TABLE IF NOT EXISTS sulla_collection_migration_paths(source_collection_id UUID NOT NULL,source_path TEXT NOT NULL,target_path TEXT NOT NULL,PRIMARY KEY(source_collection_id,source_path))`);
  let moved=0, collisions=0;
  const move=async(kind:'folder'|'file', row:any)=>{
    const client=await db.connect();
    try {
      await client.query('BEGIN');
      for (const id of [source.id,home.id].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['stored-namespace:'+id]);
      const table=kind==='folder' ? 'file_folders' : 'files';
      const current=(await client.query(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[row.id])).rows[0];
      if (current?.collection_id!==source.id) { await client.query('COMMIT'); return }
      const recorded=(await client.query('SELECT target_path FROM sulla_collection_migration_paths WHERE source_collection_id=$1 AND source_path=$2',[source.id,current.path])).rows[0]?.target_path;
      const parents=(await client.query(`SELECT source_path,target_path FROM sulla_collection_migration_paths WHERE source_collection_id=$1
        AND starts_with($2,source_path||'/') ORDER BY length(source_path) DESC LIMIT 1`,[source.id,current.path])).rows[0];
      const proposed=recorded ?? (parents ? parents.target_path+current.path.slice(parents.source_path.length) : current.path);
      const target=recorded ? {path:recorded,collision:recorded!==current.path} : await freePath(client,home.id,proposed);
      if (kind==='folder') await client.query('INSERT INTO sulla_collection_migration_paths(source_collection_id,source_path,target_path) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[source.id,current.path,target.path]);
      await client.query(`UPDATE ${table} SET collection_id=$2,path=$3 WHERE id=$1`,[current.id,home.id,target.path]);
      if (kind==='file') {
        await client.query('INSERT INTO journal(collection_id,file_id,version_id,op) VALUES($1,$2,$3,$4)',[home.id,current.id,current.current_version_id,'rename']);
        await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details) VALUES('user',$1,'sulla-files-migration',$2,$3,'sulla-collection-migration',$4)`,
          [config.userId,current.id,current.current_version_id,{from:current.path,to:target.path,sourceCollectionId:source.id}]);
        moved++;
      }
      if (target.collision) { collisions++; console.warn(`[SullaFiles] Sulla migration collision: ${current.path} -> ${target.path}`) }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  };
  for (const folder of (await db.query('SELECT id FROM file_folders WHERE collection_id=$1 ORDER BY length(path),path',[source.id])).rows) await move('folder',folder);
  for (const file of (await db.query('SELECT id FROM files WHERE collection_id=$1 ORDER BY created_at,id',[source.id])).rows) await move('file',file);
  const left=(await db.query(`SELECT (SELECT count(*) FROM files WHERE collection_id=$1)+(SELECT count(*) FROM file_folders WHERE collection_id=$1) AS n`,[source.id])).rows[0].n;
  if (Number(left)) throw new Error(`Sulla migration verification failed: ${left} rows remain`);
  if (source.explorer_path!=='.sulla-retired') await db.query("UPDATE collections SET explorer_path='.sulla-retired' WHERE id=$1",[source.id]);
  if (moved || collisions) console.log(`[SullaFiles] Sulla migration complete: moved=${moved} collisions=${collisions}`);
  return {moved,collisions};
}
