// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BackupInventoryRepository } from '../Repositories/BackupInventoryRepository.js';

import type { BackupManifest } from './container.js';
import type { SchemaEvidence } from './SchemaEvidence.js';
import type pg from 'pg';

/** Proves a staged (isolated) database can actually be recovered on a fresh device. */
export class BackupRecoverabilityCheck {
  constructor(private readonly inventory = new BackupInventoryRepository()) {}

  async assertRecoverable(pool:pg.Pool):Promise<void> {
    if (await this.inventory.vaultPrincipalCount(pool) > 1) throw new Error('Backup requires every collection to belong to the same Vault principal');
    if (await this.inventory.hasUnsupportedCollection(pool)) throw new Error('Backup requires every legacy collection to complete secure import first');
    if (await this.inventory.hasCollectionWithoutRecoveryBundle(pool)) throw new Error('Backup requires a Vault-registered recovery bundle for every collection');
  }

  /** Restored metadata, the archive's chunk entries and the manifest's schema must all agree. */
  async assertStagedInventory(pool:pg.Pool, schema:SchemaEvidence, manifest:BackupManifest):Promise<void> {
    await this.assertRecoverable(pool);
    if (await this.inventory.hasUnresolvedChunkReference(pool)) throw new Error('Restored metadata has an unresolved chunk reference');
    const chunkRows = await this.inventory.chunkSizes(pool);
    const archived = new Map(manifest.entries.filter(entry => entry.type === 'encrypted-chunk').map(entry => [entry.path, entry]));
    if (archived.size !== chunkRows.length) throw new Error('Backup chunk inventory does not match restored PostgreSQL metadata');
    for (const chunk of chunkRows) {
      const path = `chunks/${ chunk.collection_id }/${ chunk.id.slice(0, 2) }/${ chunk.id }`;
      const entry = archived.get(path);
      if (entry?.size !== Number(chunk.stored_size)) throw new Error(`Backup chunk metadata mismatch: ${ path }`);
    }
    if (JSON.stringify(schema.tables.map(table => table.name)) !== JSON.stringify((manifest.tables as SchemaEvidence['tables']).map(table => table.name))) {
      throw new Error('Backup schema evidence does not match its manifest');
    }
  }
}
