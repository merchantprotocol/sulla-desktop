// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { ProfileBoundary, type ProfileCatalogEntry } from '@sulla/vault-profiles';

/** Resolves only a catalogued identity; no caller may supply a database name. */
export class ProfileDatabaseResolver {
  constructor(private readonly boundary: ProfileBoundary = new ProfileBoundary()) {}

  resolve(entries: ProfileCatalogEntry[], profileId: string): string {
    this.boundary.assertCollisionSafe(entries);
    const entry = this.boundary.resolve(entries, profileId) as ProfileCatalogEntry;
    this.boundary.assertCollisionSafe([entry]);
    return entry.dbIdentifier;
  }
}
