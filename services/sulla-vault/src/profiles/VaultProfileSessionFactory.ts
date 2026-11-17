// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { ProfileGeneration } from '@sulla/vault-profiles';
import type { Database } from '../db.js';
import { VaultProfileSession } from './VaultProfileSession.js';

/** Dark-launch composition: disabled means the exact configured legacy pool and stable legacy identity. */
export class VaultProfileSessionFactory {
  constructor(private readonly legacyPool: Database, private readonly profileRoutingEnabled: boolean) {}

  legacy(): VaultProfileSession {
    return new VaultProfileSession({ profileId: 'legacy', generation: new ProfileGeneration(0) }, this.legacyPool);
  }

  forProfile(profileId: string, generation: number, pool: Database): VaultProfileSession {
    if (!this.profileRoutingEnabled) return this.legacy();
    return new VaultProfileSession({ profileId, generation: new ProfileGeneration(generation) }, pool);
  }
}
