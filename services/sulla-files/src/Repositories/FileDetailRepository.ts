// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** One file's detail reads: a version, its recording metadata, its edges, its activity and its history. */
export class FileDetailRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  async version(versionId:string):Promise<any | undefined> {
    return (await this.db.query('SELECT * FROM file_versions WHERE id=$1', [versionId])).rows[0];
  }

  async recording(fileId:string, versionId:string):Promise<any | undefined> {
    return (await this.db.query('SELECT version_id,language,transcript,chapters,duration_seconds,generator,generated_at FROM recording_metadata WHERE file_id=$1 AND version_id=$2', [fileId, versionId])).rows[0];
  }

  /** Every edge touching the file, newest first, with the id of the other endpoint as linked_id. */
  async edges(fileId:string):Promise<any[]> {
    return (await this.db.query(`SELECT e.*,CASE WHEN e.src_type='file' AND e.src_id=$1 THEN e.dst_id ELSE e.src_id END linked_id
        FROM edges e WHERE (e.src_type='file' AND e.src_id=$1) OR (e.dst_type='file' AND e.dst_id=$1) ORDER BY e.created_at DESC`, [fileId])).rows;
  }

  /** The file's latest 100 audit entries, newest first. */
  async activity(fileId:string, includeModelConflicts = false):Promise<any[]> {
    return (await this.db.query(`SELECT id::text,who_type,who_id,device_or_run_id,action,at,
        CASE WHEN action='use-case-model-conflict' THEN details->>'message' END AS message,
        CASE WHEN action='use-case-model-conflict' THEN version_id END AS version_id
      FROM audit_log WHERE file_id=$1 AND ($2 OR action<>'use-case-model-conflict') ORDER BY at DESC LIMIT 100`, [fileId, includeModelConflicts])).rows;
  }

  /** Every version of the file, newest first, with its major.minor number. */
  async history(fileId:string):Promise<any[]> {
    return (await this.db.query(`SELECT *,major_version::text||'.'||minor_version::text AS version_number FROM file_versions WHERE file_id=$1 ORDER BY created_at DESC`, [fileId])).rows;
  }
}
