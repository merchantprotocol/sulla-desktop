// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Config } from './config.js';
import { VaultPrincipalRepository } from './repositories/VaultPrincipalRepository.js';

export class VaultPrincipalAdopter {
  constructor(private readonly repository: VaultPrincipalRepository) {}

  async adopt(config: Pick<Config, 'userId'>, principalId: string): Promise<void> {
    if (config.userId === principalId) return;
    await this.repository.withLockedCollections(async(client, collections) => {
      if (config.userId !== 'desktop-user' || (collections.length > 0 && !collections.some(row =>
        row.owner_user_id === config.userId || row.owner_user_id === principalId))) {
        throw new Error('Existing Files collections belong to another principal; secure migration is required');
      }
      const collectionIds = collections.filter(row => row.owner_user_id === config.userId).map(row => row.id);
      if (collectionIds.length && await this.repository.hasConflictingBundle(client, collectionIds, principalId)) {
        throw new Error('Existing Files collections belong to another principal; secure migration is required');
      }
      if (collectionIds.length) {
        await this.repository.transferOwnedCollections(client, collectionIds, config.userId, principalId);
      }
    });
    config.userId = principalId;
  }
}
