// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Reads the durable Files key state that decides how FilesLifecycle bootstraps (create, recover, existing). */
export class FilesBootstrapStateRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** True when the singleton files_key_state row exists. */
  async hasKeyState():Promise<boolean> {
    return Boolean((await this.db.query('SELECT 1 FROM files_key_state WHERE id=TRUE')).rowCount);
  }

  /** True when encrypted data exists that a freshly created master key could never open. */
  async hasProtectedState():Promise<boolean> {
    const protectedState = await this.db.query(`SELECT 1 WHERE
        EXISTS(SELECT 1 FROM files_collection_keys) OR
        EXISTS(SELECT 1 FROM file_versions WHERE manifest_hash IS NOT NULL) OR
        EXISTS(SELECT 1 FROM chunks) OR
        EXISTS(SELECT 1 FROM collections
          WHERE compatibility_state<>'native' OR encrypted_data_key<>'{}'::jsonb OR dedup_key_ciphertext<>'{}'::jsonb)`);
    return Boolean(protectedState.rowCount);
  }

  /** True when a published native collection key is not a random-origin native key. */
  async hasUnsupportedRecoveryKey():Promise<boolean> {
    const unsupported = await this.db.query(`SELECT 1 FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
      WHERE c.published=TRUE AND c.legacy_source=FALSE
        AND (k.key_origin<>'random' OR c.compatibility_state<>'native') LIMIT 1`);
    return Boolean(unsupported.rowCount);
  }

  /** True when a published collection key has no owner key bundle for its current version and epoch. */
  async hasIncompleteOwnerBundle():Promise<boolean> {
    const incomplete = await this.db.query(`SELECT 1 FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
      LEFT JOIN files_collection_key_bundles b ON b.collection_id=k.collection_id AND b.principal_id=c.owner_user_id
        AND b.key_version=k.key_version AND b.key_epoch=k.key_epoch
      WHERE c.published=TRUE AND c.legacy_source=FALSE AND b.collection_id IS NULL LIMIT 1`);
    return Boolean(incomplete.rowCount);
  }

  /** Number of published, non-legacy collection keys. */
  async publishedKeyCount():Promise<number> {
    return Number((await this.db.query(`SELECT COUNT(*)::int AS count FROM files_collection_keys k
      JOIN collections c ON c.id=k.collection_id WHERE c.published=TRUE AND c.legacy_source=FALSE`)).rows[0]?.count ?? 0);
  }
}
