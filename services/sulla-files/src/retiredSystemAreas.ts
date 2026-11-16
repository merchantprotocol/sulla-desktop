// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Delegating shims for index.ts. The cleanup is Services/RetiredSystemAreaCleaner.ts and its SQL
// Repositories/RetiredSystemAreaRepository.ts; each call builds them from the passed-in pool.
import { drainPendingChunkGc } from './documentLifecycle.js';
import { TransactionRunner } from './FilesTransaction.js';
import { RetiredSystemAreaRepository } from './Repositories/RetiredSystemAreaRepository.js';
import { RetiredSystemAreaCleaner, type DeleteChunk } from './Services/RetiredSystemAreaCleaner.js';

import type pg from 'pg';

export { RetiredSystemAreaCleaner } from './Services/RetiredSystemAreaCleaner.js';

export const RETIRED_SYSTEM_AREAS = RetiredSystemAreaCleaner.retiredAreas;

function cleaner(db:pg.Pool, deleteChunk:DeleteChunk, log?:(message:string) => void):RetiredSystemAreaCleaner {
  return new RetiredSystemAreaCleaner(new RetiredSystemAreaRepository(db), new TransactionRunner(db), deleteChunk, () => drainPendingChunkGc(db, deleteChunk), log);
}

export function retireSystemAreas(db:pg.Pool, deleteChunk:DeleteChunk, log:(message:string) => void = console.log):Promise<void> {
  return cleaner(db, deleteChunk, log).retire();
}

export function startRetiredSystemAreaCleanup(db:pg.Pool, deleteChunk:DeleteChunk):void {
  cleaner(db, deleteChunk).schedule(10_000);
}
