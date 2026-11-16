// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

export interface NativeOperationIdentity {
  operationId:string; handle:string; sourceRevision:string; fileId?:string; baseVersionId?:string; desiredHash:string;
}

/**
 * Owns the SQL for native (Electron-brokered) source custody: files_native_source_operations,
 * files_native_sources and files_native_conflicts. Statements that must run inside a caller's
 * transaction take that transaction's client; everything else uses the injected pool.
 */
export class NativeSourceOperationRepository {
  constructor(private readonly db:pg.Pool) {}

  async find(operationId:string):Promise<any> {
    return (await this.db.query('SELECT * FROM files_native_source_operations WHERE operation_id=$1', [operationId])).rows[0];
  }

  async findFileAtVersion(fileId:string, versionId:string):Promise<any> {
    return (await this.db.query('SELECT * FROM files WHERE id=$1 AND current_version_id=$2', [fileId, versionId])).rows[0];
  }

  async planIngest(input:NativeOperationIdentity, versionId:string):Promise<void> {
    await this.db.query(`INSERT INTO files_native_source_operations
          (operation_id,source_handle,direction,state,source_revision,source_hash,file_id,files_base_version_id,files_version_id,desired_hash)
          VALUES($1,$2,'ingest','planned',$3,$7,$4,$5,$6,$7)`,
    [input.operationId, input.handle, input.sourceRevision, input.fileId ?? null, input.baseVersionId ?? null, versionId, input.desiredHash]);
  }

  async lockSourceHandle(client:pg.PoolClient, handle:string):Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`native-source:${ handle }`]);
  }

  async lockFileVersion(client:pg.PoolClient, fileId:string):Promise<{ current_version_id:string | null } | undefined> {
    return (await client.query('SELECT current_version_id FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
  }

  async activateSource(client:pg.PoolClient, input:{ handle:string; collectionId:string; fileId:string; path:string; sourceRevision:string; desiredHash:string }):Promise<void> {
    await client.query(`INSERT INTO files_native_sources
          (source_handle,collection_id,file_id,display_name,source_revision,source_hash,state,recovery,last_error)
          VALUES($1,$2,$3,$4,$5,$6,'active','{}',NULL)
          ON CONFLICT(file_id) DO UPDATE SET source_handle=EXCLUDED.source_handle,collection_id=EXCLUDED.collection_id,
            display_name=EXCLUDED.display_name,source_revision=EXCLUDED.source_revision,source_hash=EXCLUDED.source_hash,
            state='active',recovery='{}',last_error=NULL,updated_at=NOW()`,
    [input.handle, input.collectionId, input.fileId, input.path, input.sourceRevision, input.desiredHash]);
  }

  async completeIngest(client:pg.PoolClient, operationId:string, fileId:string, versionId:string):Promise<number | null> {
    return (await client.query(`UPDATE files_native_source_operations SET state='completed',file_id=$2,files_version_id=$3,last_error=NULL,updated_at=NOW()
          WHERE operation_id=$1 AND state='planned'`, [operationId, fileId, versionId])).rowCount;
  }

  async recordError(operationId:string, message:string):Promise<void> {
    await this.db.query('UPDATE files_native_source_operations SET last_error=$2,updated_at=NOW() WHERE operation_id=$1', [operationId, message.slice(0, 2000)]);
  }

  async planPublication(input:NativeOperationIdentity & { fileId:string; baseVersionId:string }):Promise<void> {
    await this.db.query(`INSERT INTO files_native_source_operations
      (operation_id,source_handle,direction,state,source_revision,source_hash,file_id,files_base_version_id,files_version_id,desired_hash)
      SELECT $1,$2,'publish','publishing',$3,n.source_hash,$4,$5,$5,$6 FROM files_native_sources n
      WHERE n.file_id=$4 AND n.source_handle=$2 AND n.source_revision=$3
      ON CONFLICT(operation_id) DO NOTHING`,
    [input.operationId, input.handle, input.sourceRevision, input.fileId, input.baseVersionId, input.desiredHash]);
  }

  async markPublicationRecoveryRequired(operationId:string, error:string):Promise<number | null> {
    return (await this.db.query(`UPDATE files_native_source_operations SET state='recovery-required',last_error=$2,recovery=$3::jsonb,updated_at=NOW()
        WHERE operation_id=$1 AND direction='publish' AND state='publishing'`, [operationId, error.slice(0, 2000), JSON.stringify({ action: 'compare-source-to-files-version' })])).rowCount;
  }

  async directionAndState(operationId:string):Promise<{ direction:string; state:string } | undefined> {
    return (await this.db.query('SELECT direction,state FROM files_native_source_operations WHERE operation_id=$1', [operationId])).rows[0];
  }

  async publicationIdentity(client:pg.PoolClient, operationId:string):Promise<{ file_id:string | null; direction:string } | undefined> {
    return (await client.query('SELECT file_id,direction FROM files_native_source_operations WHERE operation_id=$1', [operationId])).rows[0];
  }

  async lockSource(client:pg.PoolClient, fileId:string):Promise<any> {
    return (await client.query('SELECT * FROM files_native_sources WHERE file_id=$1 FOR UPDATE', [fileId])).rows[0];
  }

  async lockSourceState(client:pg.PoolClient, fileId:string):Promise<{ source_revision:string; source_hash:string; state:string } | undefined> {
    return (await client.query('SELECT source_revision,source_hash,state FROM files_native_sources WHERE file_id=$1 FOR UPDATE', [fileId])).rows[0];
  }

  async lockOperation(client:pg.PoolClient, operationId:string):Promise<any> {
    return (await client.query('SELECT * FROM files_native_source_operations WHERE operation_id=$1 FOR UPDATE', [operationId])).rows[0];
  }

  async markFilesAdvanced(client:pg.PoolClient, operationId:string, nextSourceRevision:string):Promise<void> {
    await client.query(`UPDATE files_native_source_operations SET state='recovery-required',next_source_revision=$2,
          last_error='Files advanced during native publication',recovery=$3::jsonb,updated_at=NOW()
          WHERE operation_id=$1 AND state IN('publishing','recovery-required')`,
    [operationId, nextSourceRevision, JSON.stringify({ action: 'compare-source-to-files-version' })]);
  }

  async advanceSource(client:pg.PoolClient, input:{ fileId:string; nextSourceRevision:string; desiredHash:string; handle:string; sourceRevision:string; sourceHash:string }):Promise<number | null> {
    return (await client.query(`UPDATE files_native_sources SET source_revision=$2,source_hash=$3,state='active',recovery='{}',last_error=NULL,updated_at=NOW()
        WHERE file_id=$1 AND source_handle=$4 AND source_revision=$5 AND source_hash=$6 RETURNING file_id`,
    [input.fileId, input.nextSourceRevision, input.desiredHash, input.handle, input.sourceRevision, input.sourceHash])).rowCount;
  }

  async completePublication(client:pg.PoolClient, operationId:string, nextSourceRevision:string):Promise<number | null> {
    return (await client.query(`UPDATE files_native_source_operations SET state='completed',next_source_revision=$2,last_error=NULL,updated_at=NOW()
        WHERE operation_id=$1 AND direction='publish' AND state IN('publishing','recovery-required') RETURNING operation_id`,
    [operationId, nextSourceRevision])).rowCount;
  }

  async lockRecoveryPublications(client:pg.PoolClient, fileId:string, boundOperationId:string | null):Promise<any[]> {
    return (await client.query(`SELECT * FROM files_native_source_operations
        WHERE file_id=$1 AND direction='publish' AND state='recovery-required'
          AND ($2::uuid IS NULL OR operation_id=$2::uuid) ORDER BY created_at DESC FOR UPDATE`, [fileId, boundOperationId])).rows;
  }

  async rebindSource(client:pg.PoolClient, input:{ fileId:string; handle:string; sourceRevision:string; operationId:string; originalHandle:string; previousHandle:string }):Promise<void> {
    await client.query(`UPDATE files_native_sources SET source_handle=$2,source_revision=$3,recovery=jsonb_build_object(
        'action','compare-source-to-files-version','publicationOperationId',$4::text,'originalHandle',$5::text,'previousHandle',$6::text),
        last_error='Interrupted native publication requires verified acknowledgement',updated_at=NOW()
        WHERE file_id=$1 AND source_handle=$6 RETURNING file_id`,
    [input.fileId, input.handle, input.sourceRevision, input.operationId, input.originalHandle, input.previousHandle]);
  }

  async completeAsConflict(operationId:string, input:{ conflictFileId:string; currentSourceRevision:string; currentSourceHash:string; currentFilesVersionId:string }):Promise<number | null> {
    return (await this.db.query(`WITH verified AS (UPDATE files_native_source_operations o SET state='completed',last_error='Native source changed; Files preserved both versions',
      recovery=jsonb_build_object('action','visible-conflict','conflictFileId',$2::text),updated_at=NOW()
      FROM files_native_sources n,files f,files_native_sources c
      WHERE o.operation_id=$1 AND o.direction='publish' AND o.state IN('publishing','recovery-required')
        AND n.source_handle=o.source_handle AND n.file_id=o.file_id AND n.source_revision=$3 AND n.source_hash=$4
        AND f.id=o.file_id AND f.current_version_id=$5
        AND c.file_id=$2 AND c.source_hash=o.desired_hash
      RETURNING o.file_id,o.desired_hash)
      INSERT INTO files_native_conflicts(file_id,source_file_id,content_hash)
      SELECT $2,file_id,desired_hash FROM verified
      ON CONFLICT(file_id) DO UPDATE SET source_file_id=EXCLUDED.source_file_id,content_hash=EXCLUDED.content_hash
      RETURNING file_id`, [operationId, input.conflictFileId, input.currentSourceRevision, input.currentSourceHash, input.currentFilesVersionId])).rowCount;
  }

  async pendingPublications():Promise<any[]> {
    return (await this.db.query(`SELECT o.operation_id::text,n.source_handle,o.source_revision,o.source_hash,o.desired_hash,o.file_id::text,
      o.files_base_version_id::text,o.files_version_id::text,o.state FROM files_native_source_operations o
      JOIN files_native_sources n ON n.file_id=o.file_id JOIN files f ON f.id=o.file_id
      WHERE o.direction='publish' AND o.state IN('publishing','recovery-required') AND f.current_version_id=o.files_version_id
        AND ((n.state='active' AND n.source_handle=o.source_handle AND n.source_revision=o.source_revision AND n.source_hash=o.source_hash)
          OR (n.state IN('active','reselect-required') AND n.source_hash=o.source_hash AND n.recovery->>'publicationOperationId'=o.operation_id::text))
      ORDER BY o.created_at LIMIT 8`)).rows;
  }

  async revalidateSessions(handles:string[], replaceExisting:boolean):Promise<void> {
    await this.db.query(`UPDATE files_native_sources SET state=CASE WHEN source_handle=ANY($1::text[]) THEN 'active' ELSE 'reselect-required' END,
      last_error=CASE WHEN source_handle=ANY($1::text[]) THEN NULL ELSE 'Native access must be reselected after the Electron session changed' END,
      recovery=CASE WHEN recovery ? 'publicationOperationId' THEN recovery || jsonb_build_object(
          'action',CASE WHEN source_handle=ANY($1::text[]) THEN 'compare-source-to-files-version' ELSE 'reselect-native-source' END,
          'previousHandle',source_handle)
        WHEN source_handle=ANY($1::text[]) THEN '{}'::jsonb
        ELSE jsonb_build_object('action','reselect-native-source') END,updated_at=NOW()
      WHERE state<>'revoked' AND ($2::boolean OR source_handle=ANY($1::text[]))`, [handles, replaceExisting]);
  }

  async recordStaleConflict(client:pg.PoolClient, conflictFileId:string, sourceFileId:string, contentHash:string):Promise<void> {
    await client.query('INSERT INTO files_native_conflicts(file_id,source_file_id,content_hash) VALUES($1,$2,$3)', [conflictFileId, sourceFileId, contentHash]);
  }

  async planFusePublication(client:pg.PoolClient, input:{ operationId:string; handle:string; sourceRevision:string; sourceHash:string; fileId:string; baseVersionId:string; versionId:string; desiredHash:string; actor:string }):Promise<void> {
    await client.query(`INSERT INTO files_native_source_operations
          (operation_id,source_handle,direction,state,source_revision,source_hash,file_id,files_base_version_id,files_version_id,desired_hash,recovery)
          VALUES($1,$2,'publish','publishing',$3,$4,$5,$6,$7,$8,$9)`,
    [input.operationId, input.handle, input.sourceRevision, input.sourceHash, input.fileId, input.baseVersionId, input.versionId, input.desiredHash,
      JSON.stringify({ action: 'publish-files-version-through-electron', actor: input.actor })]);
  }

  async publicationProgress(operationId:string):Promise<{ state:string; last_error:string | null; recovery:any } | undefined> {
    return (await this.db.query('SELECT state,last_error,recovery FROM files_native_source_operations WHERE operation_id=$1', [operationId])).rows[0];
  }

  async expirePublication(operationId:string):Promise<void> {
    await this.db.query(`UPDATE files_native_source_operations SET state='recovery-required',last_error='Electron publication did not complete before the Files durability deadline',updated_at=NOW()
      WHERE operation_id=$1 AND state='publishing'`, [operationId]);
  }

  /** Startup reconciliation: committed ingests complete; in-flight publications need a native comparison. */
  async reconcileAfterRestart():Promise<void> {
    await this.db.query(`UPDATE files_native_source_operations o SET state='completed',last_error=NULL,updated_at=NOW()
      FROM files f WHERE o.direction='ingest' AND o.state='planned' AND o.file_id=f.id AND o.files_version_id=f.current_version_id`);
    // An ingest transaction commits the Files version and operation receipt
    // together. A remaining planned row is therefore safe to retry with the
    // same immutable inputs. Publication crosses the native filesystem and
    // must be reconciled because its outcome cannot be inferred from SQL.
    await this.db.query(`UPDATE files_native_source_operations SET state='recovery-required',
      recovery=jsonb_build_object('action','compare-source-to-files-version'),
      last_error=COALESCE(last_error,'Native source session ended before the operation outcome was acknowledged'),updated_at=NOW()
      WHERE direction='publish' AND state='publishing'`);
  }
}
