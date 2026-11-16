// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { CACHE_UPDATE_TTL_MS } from './LocalAuthorityLimits.js';

/**
 * Stages a newly derived master key for the OS helper's one-shot cache update, and expires it
 * on timeout or generation change.
 * Moved verbatim from LocalVaultAuthority (E9); the staged key lives on the host.
 */
export class CacheUpdateStager {
  constructor(private readonly host: LocalAuthorityHost) {}

  stageCacheUpdate(masterKey: Uint8Array): void {
    this.host.stagedCacheUpdate?.masterKey.fill(0);
    this.host.cacheChallenges.clear();
    this.host.stagedCacheUpdate = {
      masterKey: Buffer.from(masterKey),
      expiresAt: Date.now() + CACHE_UPDATE_TTL_MS,
      generation: this.host.generation,
    };
  }

  expireStagedCacheUpdate(): void {
    if (this.host.stagedCacheUpdate &&
        (this.host.stagedCacheUpdate.expiresAt <= Date.now() || this.host.stagedCacheUpdate.generation !== this.host.generation)) {
      this.host.stagedCacheUpdate.masterKey.fill(0);
      this.host.stagedCacheUpdate = null;
      this.host.cacheChallenges.clear();
    }
  }
}
