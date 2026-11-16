// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SearchCleanupService } from './Services/SearchCleanupService.js';

import type pg from 'pg';

export { SearchCleanupService } from './Services/SearchCleanupService.js';

/** Delegating shim; the composition root should build SearchCleanupService directly. */
export function runSearchCleanup(db:pg.Pool, log:(message:string) => void = console.log):Promise<void> {
  return new SearchCleanupService(db, { log }).run();
}

/** Delegating shim for index.ts. */
export function startSearchCleanup(db:pg.Pool):void {
  new SearchCleanupService(db).start();
}
