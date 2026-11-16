// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Pre-E9 entry point for the Passwords sync v3 bookkeeping schema. The SQL
// lives in sync/repositories/PostgresSyncSchemaRepository and the
// once-per-process apply in sync/SyncSchemaInitializer.

import type { Queryable } from '../db.js';
import { SyncSchemaInitializer } from './sync/SyncSchemaInitializer.js';

/** @deprecated import SYNC_SCHEMA_SQL from sync/repositories/PostgresSyncSchemaRepository — E9 alias, removed in final cleanup */
export { SYNC_SCHEMA_SQL } from './sync/repositories/PostgresSyncSchemaRepository.js';
export { SyncSchemaInitializer };

/** The process-wide initializer behind ensureSyncSchema (the pre-E9 module flag, now instance state). */
const processSyncSchema = new SyncSchemaInitializer();

/** @deprecated use SyncSchemaInitializer — E9 alias, removed in final cleanup */
export function ensureSyncSchema(db: Queryable): Promise<void> {
  return processSyncSchema.ensure(db);
}
