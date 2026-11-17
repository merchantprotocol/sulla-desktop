// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ProfileIdentity } from './ProfileIdentity.js';
import { SENTINEL_USER_ID } from './vaultPrincipal.js';

/** A cache whose entries are partitioned by Cloud profile id. */
export interface ProfileScopedCache {
  invalidateProfile(profileId: string): void;
}

/**
 * Coordinates every profile-partitioned cache in Files. Partitions are keyed by the
 * principal id in config.userId (the Vault principal), never by a Desktop-computed id.
 */
export class ProfileCaches {
  constructor(
    private readonly caches: readonly ProfileScopedCache[],
    private readonly currentUserId: () => string,
  ) {}

  /**
   * Desktop sign-out or lock: drops the adopted principal's partition and the
   * pre-adoption sentinel partition, so no org root survives for that principal.
   */
  invalidateCurrent(): void {
    const profileIds = new Set([
      ProfileIdentity.fromCloudUserId(this.currentUserId()),
      ProfileIdentity.fromCloudUserId(SENTINEL_USER_ID),
    ]);
    for (const profileId of profileIds) this.invalidate(profileId);
  }

  /** Principal adoption moved away from `previousUserId`: that partition must not linger. */
  invalidatePrincipal(previousUserId: string): void {
    this.invalidate(ProfileIdentity.fromCloudUserId(previousUserId));
  }

  private invalidate(profileId: string): void {
    for (const cache of this.caches) cache.invalidateProfile(profileId);
  }
}
