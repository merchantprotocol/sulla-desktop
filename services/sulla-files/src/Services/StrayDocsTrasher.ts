// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Config } from '../config.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { SullaCollectionMigrationRepository } from '../Repositories/SullaCollectionMigrationRepository.js';

/**
 * Bundled Docs were once ingested into a tracked Mac folder's collection instead of home. Those
 * copies never existed on the Mac (no watched-folder state), and home holds its own Docs, so they
 * are moved to Trash with a normal delete version and journal entry (recoverable, and Cloud
 * backup sees the delete).
 */
export class StrayDocsTrasher {
  constructor(private readonly repository:SullaCollectionMigrationRepository, private readonly transactions:TransactionRunner) {}

  async trash(config:Config):Promise<number> {
    let trashed = 0;
    for (const row of await this.repository.strayDocs()) {
      const moved = await this.transactions.run('stray-docs-trash', async client => {
        const file = await this.repository.lockFileState(client, row.id);
        if (!file || file.deleted_at) return false;
        await this.repository.trashStrayDoc(client, row, file.current_version_id, config.userId, config.deviceId);
        return true;
      });
      if (moved) trashed++;
    }
    if (trashed) console.log(`[SullaFiles] moved ${ trashed } stray bundled Docs files out of tracked folders to Trash`);
    return trashed;
  }
}
