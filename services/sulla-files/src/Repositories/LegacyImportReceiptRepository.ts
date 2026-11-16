// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface LegacyImportCounts { collections: number; files: number; versions: number }

/** The durable completion receipt, its revalidation, and containment of failed sources. */
export class LegacyImportReceiptRepository {
  async isCompleted(client:pg.PoolClient):Promise<boolean> {
    return Boolean((await client.query("SELECT 1 FROM files_legacy_imports WHERE id=TRUE AND state='completed'")).rowCount);
  }

  async sourceIdentityIncomplete(client:pg.PoolClient):Promise<boolean> {
    const incompleteIdentity = await client.query(`SELECT 1 FROM collections c LEFT JOIN files_legacy_collection_map cm ON cm.source_collection_id=c.id
        WHERE c.legacy_source=TRUE AND (cm.source_collection_id IS NULL OR cm.published_at IS NULL)
        UNION ALL SELECT 1 FROM files f JOIN collections c ON c.id=f.collection_id AND c.legacy_source=TRUE
          LEFT JOIN files_legacy_file_map fm ON fm.source_file_id=f.id WHERE fm.source_file_id IS NULL LIMIT 1`);
    return Boolean(incompleteIdentity.rowCount);
  }

  /** Legacy versions written after the receipt, and whether they only extend each file linearly. */
  async versionDrift(client:pg.PoolClient):Promise<{ count: number; continuable: boolean }> {
    const versionDrift = (await client.query(`SELECT count(*)::int count,
          COALESCE(bool_and(source.current_version_id=v.id AND (
            (v.parent_version_id IS NULL AND shadow.current_version_id IS NULL) OR parent.shadow_version_id=shadow.current_version_id
          ) AND (v.base_server_version_id IS NULL OR base.shadow_version_id IS NOT NULL)),FALSE) continuable
        FROM file_versions v JOIN files source ON source.id=v.file_id JOIN collections c ON c.id=source.collection_id AND c.legacy_source=TRUE
        JOIN files_legacy_file_map fm ON fm.source_file_id=source.id JOIN files shadow ON shadow.id=fm.shadow_file_id
        LEFT JOIN files_legacy_version_map vm ON vm.source_version_id=v.id
        LEFT JOIN files_legacy_version_map parent ON parent.source_version_id=v.parent_version_id
        LEFT JOIN files_legacy_version_map base ON base.source_version_id=v.base_server_version_id
        WHERE vm.source_version_id IS NULL`)).rows[0];
    return { count: Number(versionDrift.count), continuable: Boolean(versionDrift.continuable) };
  }

  /** Reviewed unbounded read: three scalar subquery counts, one row. */
  async counts(client:pg.PoolClient):Promise<LegacyImportCounts> {
    return (await client.query(`SELECT
        (SELECT count(*)::int FROM files_legacy_collection_map cm JOIN collections c ON c.id=cm.source_collection_id AND c.legacy_source=TRUE) collections,
        (SELECT count(*)::int FROM files_legacy_file_map fm JOIN files f ON f.id=fm.source_file_id JOIN collections c ON c.id=f.collection_id AND c.legacy_source=TRUE) files,
        (SELECT count(*)::int FROM files_legacy_version_map vm JOIN file_versions v ON v.id=vm.source_version_id JOIN files f ON f.id=v.file_id JOIN collections c ON c.id=f.collection_id AND c.legacy_source=TRUE) versions`)).rows[0];
  }

  /** Keeps failed legacy sources unpublished and protected, and records the quarantine. */
  async quarantineSources(client:pg.PoolClient):Promise<void> {
    await client.query(`UPDATE collections SET legacy_source=TRUE,published=FALSE
        WHERE compatibility_state<>'native' OR legacy_source=TRUE`);
    await client.query(`INSERT INTO files_protected_files(file_id)
        SELECT f.id FROM files f JOIN collections c ON c.id=f.collection_id WHERE c.legacy_source=TRUE
        ON CONFLICT DO NOTHING`);
    await client.query(`INSERT INTO files_legacy_preflight(id,state,protected_prefix,reason,detected_at,checked_at)
        VALUES(TRUE,'secure-import-required',NULL,'quarantined-import-validation',NOW(),NOW())
        ON CONFLICT(id) DO UPDATE SET state='secure-import-required',reason='quarantined-import-validation',checked_at=NOW()`);
  }
}
