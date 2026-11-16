// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

import { homeQuery } from '../sullaCollectionMigration.js';

/** System-authored files in the owner's home collection, for the desktop-only /v1/local/system-areas helpers (moved from app.ts). */
export class HomeSystemFileRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** The home collection the 'sulla' system area writes owned content into. */
  async systemAreas(userId:string):Promise<any[]> {
    return (await this.db.query(`SELECT home.id,'sulla' AS "systemArea" FROM (${ homeQuery }) home`, [userId])).rows;
  }

  async lockHomeFile(client:pg.PoolClient, fileId:string):Promise<any> {
    return (await client.query(`SELECT f.* FROM files f JOIN collections c ON c.id=f.collection_id
      WHERE f.id=$1 AND c.system_area IS NULL FOR UPDATE`, [fileId])).rows[0];
  }

  async move(client:pg.PoolClient, fileId:string, targetPath:string):Promise<any> {
    return (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [fileId, targetPath])).rows[0];
  }

  async auditMove(client:pg.PoolClient, userId:string, deviceId:string, fileId:string, versionId:string | null, details:{ from:string; to:string }):Promise<void> {
    await client.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES('user',$1,$2,$3,$4,'system-area-move',$5)`, [userId, deviceId, fileId, versionId, details]);
  }

  async homeFile(fileId:string):Promise<any> {
    return (await this.db.query(`SELECT f.id FROM files f JOIN collections c ON c.id=f.collection_id WHERE f.id=$1 AND c.system_area IS NULL`, [fileId])).rows[0];
  }

  async audit(userId:string, deviceId:string, fileId:string | null, versionId:string | null, action:string, details:unknown):Promise<void> {
    await this.db.query(`INSERT INTO audit_log(who_type,who_id,device_or_run_id,file_id,version_id,action,details)
      VALUES('user',$1,$2,$3,$4,$5,$6)`, [userId, deviceId, fileId, versionId, action, details]);
  }
}
