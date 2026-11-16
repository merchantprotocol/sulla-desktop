// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesIdentity } from '../auth.js';
import type { Config } from '../config.js';

/**
 * The identity cloud sync writes as (pulled files, folders and delete tombstones).
 *
 * Every field is read from the live Files config on each access. CloudSyncService is built before
 * Vault unlocks; VaultPrincipalAdoption then moves config.userId from the "desktop-user" sentinel to
 * the Vault principal. An identity copied at construction kept the sentinel and stamped pulled
 * versions and folders with an owner that no longer owned anything.
 */
export class CloudSyncActor implements FilesIdentity {
  readonly kind = 'capability' as const;

  constructor(private readonly config:Readonly<Pick<Config, 'userId' | 'deviceId' | 'orgId'>>) {}

  get userId():string { return this.config.userId }
  get deviceId():string { return this.config.deviceId }
  get orgId():string | undefined { return this.config.orgId }
}
