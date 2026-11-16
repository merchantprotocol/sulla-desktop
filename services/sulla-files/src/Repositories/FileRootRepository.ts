// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import type { FileRootConfig } from '../config.js';

export interface FileRootRow {
  id:string; display_name:string; collection_id:string; sync_mode:'local' | 'server'; paused:boolean; exclusions:string[] | null; state:string;
  pending_files:number; last_error:string | null; last_scan_at:Date | null; last_sync_at:Date | null;
}

/** SQL for tracked roots (file_roots), their home collections, and the single files_runtime_state row. */
export class FileRootRepository {
  constructor(private readonly db:pg.Pool) {}

  async findHomeCollection(client:pg.PoolClient, id:string, userId:string, primary:boolean):Promise<string | undefined> {
    return (await client.query(`SELECT c.id FROM collections c WHERE c.owner_user_id=$2 AND c.kind='knowledge' AND c.published=TRUE AND c.legacy_source=FALSE
        AND (c.id=$1 OR c.id=(SELECT shadow_collection_id FROM files_legacy_collection_map WHERE source_collection_id=$1)
          OR ($3 AND c.system_area IS NULL AND c.explorer_path=''))
        ORDER BY (c.id=$1) DESC,c.created_at LIMIT 1`, [id, userId, primary])).rows[0]?.id;
  }

  async createHomeCollection(client:pg.PoolClient, input:{ id:string; orgId:string | null; userId:string; name:string; home:'synced' | 'desktop-only' }):Promise<void> {
    await client.query(`INSERT INTO collections(id,org_id,owner_user_id,name,kind,home,encrypted_data_key,dedup_key_ciphertext,retention_policy)
          VALUES($1,$2,$3,$4,'knowledge',$5,'{}','{}',$6)`, [input.id, input.orgId, input.userId, input.name, input.home, { trashDays: 90 }]);
  }

  async setCollectionKeys(client:pg.PoolClient, id:string, data:unknown, dedup:unknown):Promise<void> {
    await client.query('UPDATE collections SET encrypted_data_key=$2,dedup_key_ciphertext=$3 WHERE id=$1', [id, data, dedup]);
  }

  async setCollectionOrg(client:pg.PoolClient, id:string, orgId:string):Promise<void> {
    await client.query('UPDATE collections SET org_id=$2,updated_at=NOW() WHERE id=$1', [id, orgId]);
  }

  async upsertConfigured(root:FileRootConfig, collectionId:string):Promise<void> {
    await this.db.query(`INSERT INTO file_roots(id,collection_id,display_name,mount_path,sync_mode,paused,exclusions,enabled,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,$8)
        ON CONFLICT(id) DO UPDATE SET collection_id=EXCLUDED.collection_id,display_name=EXCLUDED.display_name,mount_path=EXCLUDED.mount_path,
          sync_mode=EXCLUDED.sync_mode,paused=EXCLUDED.paused,exclusions=EXCLUDED.exclusions,enabled=TRUE,state=EXCLUDED.state,updated_at=NOW()`,
    [root.id, collectionId, root.name, root.path, root.syncMode, root.paused, JSON.stringify(root.exclusions), root.paused ? 'paused' : 'idle']);
  }

  async upsertBrokered(input:{ id:string; name:string; syncMode:string; paused:boolean; exclusions:string[] }, collectionId:string):Promise<void> {
    await this.db.query(`INSERT INTO file_roots(id,collection_id,display_name,mount_path,sync_mode,paused,exclusions,enabled,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,$8)
      ON CONFLICT(id) DO UPDATE SET collection_id=EXCLUDED.collection_id,display_name=EXCLUDED.display_name,
        mount_path=EXCLUDED.mount_path,sync_mode=EXCLUDED.sync_mode,paused=EXCLUDED.paused,exclusions=EXCLUDED.exclusions,
        enabled=TRUE,state=EXCLUDED.state,last_error=NULL,updated_at=NOW()`,
    [input.id, collectionId, input.name, `/brokered/${ input.id }`, input.syncMode, input.paused, JSON.stringify(input.exclusions), input.paused ? 'paused' : 'scanning']);
  }

  async detachAll():Promise<void> {
    await this.db.query("UPDATE file_roots SET enabled=FALSE,state='detached',updated_at=NOW()");
  }

  async detachAllExcept(ids:string[]):Promise<void> {
    await this.db.query("UPDATE file_roots SET enabled=FALSE,state='detached',updated_at=NOW() WHERE NOT(id=ANY($1::text[]))", [ids]);
  }

  async listEnabled():Promise<FileRootRow[]> {
    return (await this.db.query(`SELECT id,display_name,collection_id,sync_mode,paused,exclusions,state,pending_files,last_error,last_scan_at,last_sync_at
      FROM file_roots WHERE enabled=TRUE ORDER BY created_at`)).rows;
  }

  async setScanState(id:string, state:string, pendingFiles:number, lastError:string | null):Promise<number | null> {
    return (await this.db.query(`UPDATE file_roots SET state=$2,pending_files=$3,last_error=$4,
      last_scan_at=CASE WHEN $2 IN ('idle','error') THEN NOW() ELSE last_scan_at END,updated_at=NOW()
      WHERE id=$1 AND enabled=TRUE RETURNING id`, [id, state, pendingFiles, lastError])).rowCount;
  }

  async findEnabledSettings(id:string):Promise<{ paused:boolean; sync_mode:'local' | 'server'; exclusions:string[] | null; mount_path:string } | undefined> {
    return (await this.db.query('SELECT paused,sync_mode,exclusions,mount_path FROM file_roots WHERE id=$1 AND enabled=TRUE', [id])).rows[0];
  }

  async configure(id:string, paused:boolean, syncMode:string, exclusions:string[]):Promise<void> {
    await this.db.query(`UPDATE file_roots SET paused=$2,sync_mode=$3,exclusions=$4,state=$5,last_error=NULL,updated_at=NOW() WHERE id=$1 AND enabled=TRUE`,
      [id, paused, syncMode, JSON.stringify(exclusions), paused ? 'paused' : 'idle']);
  }

  /** Detach forgets scan custody only; files, versions and history stay. Returns false when no enabled root matched. */
  async detach(client:pg.PoolClient, id:string):Promise<boolean> {
    const result = await client.query("UPDATE file_roots SET enabled=FALSE,paused=TRUE,state='detached',pending_files=0,last_error=NULL,updated_at=NOW() WHERE id=$1 AND enabled=TRUE RETURNING collection_id", [id]);
    if (!result.rowCount) return false;
    await client.query('DELETE FROM watched_folder_state WHERE root_id=$1', [id]);
    return true;
  }

  async savedRuntimeState():Promise<{ paused:boolean; last_error:string | null; last_scan_at:Date | null; last_sync_at:Date | null } | undefined> {
    return (await this.db.query('SELECT paused,last_error,last_scan_at,last_sync_at FROM files_runtime_state WHERE id=TRUE')).rows[0];
  }

  async setRuntimePaused(paused:boolean):Promise<void> {
    await this.db.query('UPDATE files_runtime_state SET paused=$1,state=$2,updated_at=NOW() WHERE id=TRUE', [paused, paused ? 'paused' : 'synced']);
  }

  async markRuntimeError(message:string):Promise<void> {
    await this.db.query("UPDATE files_runtime_state SET state='error',last_error=$1,updated_at=NOW() WHERE id=TRUE", [message]);
  }
}
