// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type pg from 'pg';

import type { VaultConfig } from './config.js';
import { VaultDatabaseRuntime } from './database/VaultDatabaseRuntime.js';

export type Database = pg.Pool;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

/** @deprecated use VaultDatabaseErrorClassifier#isTransient (VaultDatabaseRuntime.shared.errors) — E9 alias, removed in final cleanup */
export function isTransientDbError(error: unknown): boolean {
  return VaultDatabaseRuntime.shared.errors.isTransient(error);
}

/** @deprecated use VaultDatabaseErrorClassifier#describe (VaultDatabaseRuntime.shared.errors) — E9 alias, removed in final cleanup */
export function describeDbError(error: unknown): string {
  return VaultDatabaseRuntime.shared.errors.describe(error);
}

/** @deprecated use DatabaseOutageLog#warn (VaultDatabaseRuntime.shared.outageLog) — E9 alias, removed in final cleanup */
export function warnDatabaseUnavailable(error: unknown): void {
  VaultDatabaseRuntime.shared.outageLog.warn(error);
}

/** @deprecated use DatabaseReadiness#untilReady (VaultDatabaseRuntime.shared.readiness) — E9 alias, removed in final cleanup */
export function untilDatabaseReady<T>(label: string, operation: () => Promise<T>): Promise<T> {
  return VaultDatabaseRuntime.shared.readiness.untilReady(label, operation);
}

/** @deprecated use VaultDatabaseConnector#ensureVaultDatabase (VaultDatabaseRuntime.shared.connector) — E9 alias, removed in final cleanup */
export function ensureVaultDatabase(config: VaultConfig): Promise<void> {
  return VaultDatabaseRuntime.shared.connector.ensureVaultDatabase(config);
}

/** @deprecated use VaultDatabaseConnector#connect (VaultDatabaseRuntime.shared.connector) — E9 alias, removed in final cleanup */
export function connectDatabase(config: VaultConfig): Promise<Database> {
  return VaultDatabaseRuntime.shared.connector.connect(config);
}

/** @deprecated use VaultMigrator#migrate — E9 alias, removed in final cleanup. Migrations resolve relative to this module's directory, as before. */
export function migrate(db: Database): Promise<void> {
  return VaultDatabaseRuntime.shared.migrator(dirname(fileURLToPath(import.meta.url))).migrate(db);
}
