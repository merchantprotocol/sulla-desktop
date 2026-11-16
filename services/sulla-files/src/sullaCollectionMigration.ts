// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Delegating shims for index.ts and app.ts. The work is Services/SullaCollectionMigrator.ts and
// Services/StrayDocsTrasher.ts; the SQL is Repositories/SullaCollectionMigrationRepository.ts.
import { TransactionRunner } from './FilesTransaction.js';
import { SullaCollectionMigrationRepository } from './Repositories/SullaCollectionMigrationRepository.js';
import { StrayDocsTrasher } from './Services/StrayDocsTrasher.js';
import { SullaCollectionMigrator, type SullaCollectionMigrationSummary } from './Services/SullaCollectionMigrator.js';

import type { Config } from './config.js';
import type pg from 'pg';

export { StrayDocsTrasher } from './Services/StrayDocsTrasher.js';
export { SullaCollectionMigrator, type SullaCollectionMigrationSummary } from './Services/SullaCollectionMigrator.js';

/** The owner's home collection (backs the default Files root). */
export const homeQuery = SullaCollectionMigrationRepository.homeQuery;

export function migrateSullaCollection(db:pg.Pool, config:Config):Promise<SullaCollectionMigrationSummary> {
  return new SullaCollectionMigrator(new SullaCollectionMigrationRepository(db), new TransactionRunner(db)).migrate(config);
}

export function trashStrayDocs(db:pg.Pool, config:Config):Promise<number> {
  return new StrayDocsTrasher(new SullaCollectionMigrationRepository(db), new TransactionRunner(db)).trash(config);
}
