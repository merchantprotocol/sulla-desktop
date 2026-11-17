// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ProfileCatalogEntry } from '@sulla/vault-profiles';
import type { ProfileDatabaseProvisioner } from './ProfileDatabaseProvisioner.js';

/** Explicit opt-in gate; disabled means no admin SQL and no provisioning side effects. */
export class ProfileProvisioningFeature {
  constructor(
    private readonly enabled: boolean,
    private readonly provisioner: ProfileDatabaseProvisioner,
  ) {}

  async provision(entry: ProfileCatalogEntry, catalog: ProfileCatalogEntry[]): Promise<boolean> {
    if (!this.enabled) return false;
    await this.provisioner.provision(entry, catalog);
    return true;
  }
}
