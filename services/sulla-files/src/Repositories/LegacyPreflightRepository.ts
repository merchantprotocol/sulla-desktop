// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface LegacyPreflightRecord { state: string; protected_prefix: string | null }

/** The persisted legacy-store classification and the containment it implies. */
export class LegacyPreflightRepository {
  constructor(private readonly db:Queryable) {}

  /**
   * Migration 009 establishes this classification, and every unlock repeats it
   * so a late/imported external row can never be mistaken for native material.
   */
  async classifyExternalCollections():Promise<void> {
    await this.db.query(`UPDATE collections c SET compatibility_state='legacy-external-data'
    WHERE NOT EXISTS (SELECT 1 FROM files_collection_keys k WHERE k.collection_id=c.id)
      AND (
        c.kind='scratch'
        OR EXISTS (SELECT 1 FROM files f WHERE f.collection_id=c.id AND f.created_by_type='agent-run')
        OR c.encrypted_data_key <> '{}'::jsonb
        OR c.dedup_key_ciphertext <> '{}'::jsonb
      )`);
  }

  async previous():Promise<LegacyPreflightRecord | undefined> {
    return (await this.db.query('SELECT state,protected_prefix FROM files_legacy_preflight WHERE id=TRUE')).rows[0];
  }

  async externalCollectionIds():Promise<string[]> {
    return (await this.db.query("SELECT id::text FROM collections WHERE compatibility_state='legacy-external-data'")).rows.map(row => String(row.id));
  }

  async publishedSourceCollectionIds():Promise<string[]> {
    return (await this.db.query('SELECT source_collection_id::text FROM files_legacy_collection_map WHERE published_at IS NOT NULL')).rows.map(row => String(row.source_collection_id));
  }

  async importCompleted():Promise<boolean> {
    return Boolean((await this.db.query("SELECT 1 FROM files_legacy_imports WHERE id=TRUE AND state='completed'")).rowCount);
  }

  /** Never downgrades a recorded secure-import requirement, and keeps the first prefix/reason/detection time. */
  async record(required:boolean, protectedPrefix:string | undefined):Promise<void> {
    await this.db.query(`INSERT INTO files_legacy_preflight(id,state,protected_prefix,reason,detected_at,checked_at)
    VALUES(TRUE,$1,$2,$3,CASE WHEN $1='secure-import-required' THEN NOW() ELSE NULL END,NOW())
    ON CONFLICT(id) DO UPDATE SET state=CASE WHEN files_legacy_preflight.state='secure-import-required' THEN files_legacy_preflight.state ELSE EXCLUDED.state END,
      protected_prefix=COALESCE(files_legacy_preflight.protected_prefix,EXCLUDED.protected_prefix),reason=COALESCE(files_legacy_preflight.reason,EXCLUDED.reason),
      detected_at=COALESCE(files_legacy_preflight.detected_at,EXCLUDED.detected_at),checked_at=NOW()`,
    [required ? 'secure-import-required' : 'clear', protectedPrefix ?? null, required ? 'retired-external-chunk-store' : null]);
  }

  /** Protects watched files at or below the retired chunk-tree prefix (case-insensitive). */
  async protectWatchedPrefix(protectedPrefix:string):Promise<void> {
    await this.db.query(`INSERT INTO files_protected_files(file_id)
      SELECT f.id FROM files f JOIN watched_folder_state w ON w.file_id=f.id
      WHERE lower(w.path)=lower($1) OR starts_with(lower(w.path),lower($1)||'/') ON CONFLICT DO NOTHING`, [protectedPrefix]);
  }
}
