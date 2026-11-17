// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { ProfileBoundary, type ProfileCatalogEntry } from '@sulla/vault-profiles';
import { PostgresProfileDatabaseRepository } from '../repositories/PostgresProfileDatabaseRepository.js';

/** Dark-launch provisioning primitive; never called by the live vault path. */
export class ProfileDatabaseProvisioner {
  constructor(
    private readonly databases: PostgresProfileDatabaseRepository,
    private readonly boundary: ProfileBoundary = new ProfileBoundary(),
  ) {}

  async provision(entry: ProfileCatalogEntry, catalog: ProfileCatalogEntry[]): Promise<void> {
    this.boundary.assertCollisionSafe([...catalog, entry]);
    await this.databases.createIfMissing(entry.dbIdentifier);
  }
}
