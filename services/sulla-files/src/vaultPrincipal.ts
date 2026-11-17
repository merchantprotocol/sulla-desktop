// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TransactionRunner } from './FilesTransaction.js';
import { VaultPrincipalRepository } from './Repositories/VaultPrincipalRepository.js';

import type { Config } from './config.js';
import type pg from 'pg';

/** The pre-adoption principal every Files store starts under. */
export const SENTINEL_USER_ID = 'desktop-user';
const FOREIGN_PRINCIPAL = 'Existing Files collections belong to another principal; secure migration is required';

/**
 * Moves the Files store from the "desktop-user" sentinel to the principal Vault
 * unlocked. Refuses (and changes nothing) when any collection, or a custody
 * bundle for a sentinel collection, already belongs to someone else.
 */
export class VaultPrincipalAdoption {
  constructor(
    db:Pick<pg.Pool, 'connect' | 'query'>,
    private readonly principals = new VaultPrincipalRepository(db),
    private readonly transactions = new TransactionRunner(db),
    /** Called with the previous principal after a change, so its cached keys are zeroized. */
    private readonly onPrincipalChanged:(previousUserId:string)=>void = () => undefined,
  ) {}

  async adopt(config:Pick<Config, 'userId'>, principalId:string):Promise<void> {
    if (config.userId === principalId) return;
    await this.transactions.run('files-vault-principal-adoption', async client => {
      const rows = await this.principals.lockCollectionOwners(client);
      if (config.userId !== SENTINEL_USER_ID || (rows.length > 0 && !rows.some(row => row.owner_user_id === config.userId || row.owner_user_id === principalId))) {
        throw new Error(FOREIGN_PRINCIPAL);
      }
      const sentinelIds = rows.filter(row => row.owner_user_id === config.userId).map(row => row.id);
      if (sentinelIds.length && await this.principals.hasBundleForOtherPrincipal(sentinelIds, principalId, client)) throw new Error(FOREIGN_PRINCIPAL);
      if (sentinelIds.length) {
        await this.principals.reassignShareLinks(sentinelIds, principalId, config.userId, client);
        await this.principals.reassignCollections(sentinelIds, principalId, client);
      }
    });
    const previousUserId = config.userId;
    config.userId = principalId;
    this.onPrincipalChanged(previousUserId);
  }
}
