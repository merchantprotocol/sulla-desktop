// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { VectorBackfillService } from './Services/VectorBackfillService.js';

import type pg from 'pg';

export { VectorBackfillService } from './Services/VectorBackfillService.js';

/** Delegating shim for index.ts; the composition root should build VectorBackfillService directly. */
export function runVectorBackfill(db:pg.Pool, log:(message:string) => void = console.log):Promise<void> {
  return new VectorBackfillService(db, { log }).run();
}

/** Delegating shim for index.ts: starts the backfill shortly after startup; never awaited. */
export function startVectorBackfill(db:pg.Pool):void {
  new VectorBackfillService(db).start();
}
