// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DatabaseOutageLog } from './DatabaseOutageLog.js';
import { DatabaseReadiness } from './DatabaseReadiness.js';
import { VaultDatabaseConnector } from './VaultDatabaseConnector.js';
import { VaultDatabaseErrorClassifier } from './VaultDatabaseErrorClassifier.js';
import { VaultMigrator } from './VaultMigrator.js';

/**
 * Composition of the vault's database services. `shared` is the one process-wide
 * instance behind the deprecated db.ts free functions, so the outage-log throttle
 * is shared by every caller exactly as the old module-level timestamp was.
 */
export class VaultDatabaseRuntime {
  static readonly shared = new VaultDatabaseRuntime();

  readonly errors: VaultDatabaseErrorClassifier;
  readonly outageLog: DatabaseOutageLog;
  readonly readiness: DatabaseReadiness;
  readonly connector: VaultDatabaseConnector;

  constructor(errors: VaultDatabaseErrorClassifier = new VaultDatabaseErrorClassifier()) {
    this.errors = errors;
    this.outageLog = new DatabaseOutageLog(errors);
    this.readiness = new DatabaseReadiness(errors);
    this.connector = new VaultDatabaseConnector(this.outageLog, this.readiness);
  }

  migrator(moduleDir: string): VaultMigrator {
    return new VaultMigrator(moduleDir);
  }
}
