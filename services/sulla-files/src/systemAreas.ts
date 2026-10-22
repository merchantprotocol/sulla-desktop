import { randomUUID } from 'node:crypto';

import type { Config } from './config.js';
import type pg from 'pg';

const AREAS = [
  { key: 'logs', name: 'Logs', explorerPath: 'Logs', folders: ['audit/files', 'audit/vault', 'app'] },
  { key: 'training-data', name: 'Training Data', explorerPath: 'Training Data', folders: [] },
  { key: 'home', name: 'Files', explorerPath: '', folders: [
    { path: 'Docs' }, { path: 'Use Cases/skills' }, { path: 'Use Cases/workflows' }, { path: 'Use Cases/agents' },
    { path: 'Use Cases/functions' }, { path: 'Use Cases/recipes' }, { path: 'Projects' }, { path: 'Identity' },
    { path: 'Memory', description: 'Durable agent memory. Memory files are live as soon as they are written (no publish step). Record durable facts as observations too.' },
    { path: 'Memory/claude-code', description: 'Claude Code project memory files.' },
    { path: 'Memory/codex', description: 'Codex CLI memory database snapshot.' },
    { path: 'Memory/sulla', description: 'Memories written by Sulla agents and services.' },
  ] },
] as const;

export async function ensureSystemAreas(db:pg.Pool, config:Config):Promise<void> {
  if (!config.keyring?.unlocked) throw new Error('Files keyring must be unlocked before system areas are initialized');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const area of AREAS) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`system-area:${ area.key }`]);
      let collection = area.key === 'home'
        ? (await client.query("SELECT * FROM collections WHERE owner_user_id=$1 AND system_area IS NULL AND published=TRUE AND legacy_source=FALSE ORDER BY is_default DESC,(explorer_path='') DESC,created_at LIMIT 1", [config.userId])).rows[0]
        : (await client.query('SELECT * FROM collections WHERE system_area=$1', [area.key])).rows[0];
      if (!collection) {
        const id = randomUUID();
        collection = (await client.query(`INSERT INTO collections
          (id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy,explorer_path,system_area)
          VALUES($1,$2,$3,$4,'knowledge','desktop-only',$5,$6,'{}',$8,$7) RETURNING *`,
        [id, config.orgId ?? null, config.userId, area.name, {}, {}, area.key === 'home' ? null : area.key, area.explorerPath])).rows[0];
        const wrapped = await config.keyring.create(id, client);
        await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1', [id, wrapped.data, wrapped.dedup]);
      }
      for (const folderEntry of area.folders) {
        const folder = typeof folderEntry === 'string' ? folderEntry : folderEntry.path;
        const parts = folder.split('/');
        for (let index = 1; index <= parts.length; index++) {
          const path = parts.slice(0, index).join('/');
          const description = index === parts.length && typeof folderEntry !== 'string' && 'description' in folderEntry ? folderEntry.description : null;
          await client.query(`INSERT INTO file_folders(collection_id,path,created_by_type,created_by_id,description)
            VALUES($1,$2,'service','sulla-files',$3) ON CONFLICT(collection_id,path) DO UPDATE
            SET description=COALESCE(EXCLUDED.description,file_folders.description)`, [collection.id, path, description]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Read-only system storage is structural: no caller grants can override it. */
export function assertSystemAreaWritable(area:unknown):void {
  if (area === 'logs' || area === 'training-data') {
    throw Object.assign(new Error('System area is read-only'), {status:403,code:'EROFS'});
  }
}
