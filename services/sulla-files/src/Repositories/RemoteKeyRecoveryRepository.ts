// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesKeyBundleContext } from '@sulla/vault-crypto';
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'>;

/** files_remote_key_recovery: proof that Vault recovered the exact current collection keys. */
export class RemoteKeyRecoveryRepository {
  constructor(private readonly db:Queryable) {}

  /** One row per collection; a newer verification replaces the context and timestamp. */
  async recordVerified(context:FilesKeyBundleContext, authorityKeyId:string, client:Queryable = this.db):Promise<void> {
    await client.query(
      `INSERT INTO files_remote_key_recovery
            (collection_id,principal_id,key_version,key_epoch,authority_key_id,verified_at)
           VALUES($1,$2,$3,$4,$5,NOW())
           ON CONFLICT(collection_id) DO UPDATE SET
             principal_id=EXCLUDED.principal_id,key_version=EXCLUDED.key_version,
             key_epoch=EXCLUDED.key_epoch,authority_key_id=EXCLUDED.authority_key_id,
             verified_at=EXCLUDED.verified_at`,
      [context.collectionId, context.principalId, context.keyVersion, context.epoch, authorityKeyId],
    );
  }
}
