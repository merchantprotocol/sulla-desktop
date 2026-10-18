import { timingSafeEqual } from 'node:crypto';

import {
  generateX25519RecipientKeyPair,
  openFilesKeyBundle,
  type FilesKeyBundleContext,
} from '@sulla/vault-crypto';

import { FilesKeyBundleRecovery, type FilesKeyBundleAuthority } from './keyBundleRecovery.js';

import type { FilesKeyring } from './keyring.js';
import type pg from 'pg';

interface CurrentKeyContextRow {
  collection_id:       string;
  owner_user_id:       string;
  key_version:         number;
  key_epoch:           number;
  key_origin:          string;
  compatibility_state: string;
}

/**
 * Proves that Vault can recover the exact current random collection keys.
 * Only opaque envelopes cross the service boundary; recovered key bytes are
 * compared in memory, zeroed, and never returned to callers.
 */
export class SecureCollectionKeyExchange {
  constructor(
    private readonly db:pg.Pool,
    private readonly keyring:FilesKeyring,
    private readonly authority:FilesKeyBundleAuthority,
    private readonly recovery = new FilesKeyBundleRecovery(db, keyring, authority),
  ) {}

  async verifyRemoteRecoverability(collectionId:string):Promise<FilesKeyBundleContext> {
    const row = await this.currentContext(collectionId);
    if (row.key_origin !== 'random' || row.compatibility_state !== 'native') {
      throw new Error('Online-only requires a native random collection key');
    }
    const context:FilesKeyBundleContext = {
      collectionId: row.collection_id,
      principalId:  row.owner_user_id,
      keyVersion:   Number(row.key_version),
      epoch:        Number(row.key_epoch),
    };
    const bundle = await this.recovery.enrollCollection(collectionId);
    if (!sameContext(bundle.context, context)) throw new Error('Persisted recovery bundle context is stale');

    const device = await generateX25519RecipientKeyPair();
    const local = await this.keyring.copyKeys(collectionId);
    let recovered:{ dataKey: Uint8Array; dedupKey: Uint8Array } | undefined;
    try {
      const envelope = await this.authority.authorizeDeviceRecovery({ context, devicePublicKey: device.publicKey });
      recovered = await openFilesKeyBundle(envelope, context, 'device-recovery', device.publicKey, device.privateKey);
      if (!equal(local.data, recovered.dataKey) || !equal(local.dedup, recovered.dedupKey)) {
        throw new Error('Remote custody recovered different collection keys');
      }

      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        const current = await this.currentContext(collectionId, client);
        if (!sameRowContext(current, context) || current.key_origin !== 'random' || current.compatibility_state !== 'native') {
          throw new Error('Collection key context changed during remote recovery verification');
        }
        await client.query(
          `INSERT INTO files_remote_key_recovery
            (collection_id,principal_id,key_version,key_epoch,authority_key_id,verified_at)
           VALUES($1,$2,$3,$4,$5,NOW())
           ON CONFLICT(collection_id) DO UPDATE SET
             principal_id=EXCLUDED.principal_id,key_version=EXCLUDED.key_version,
             key_epoch=EXCLUDED.key_epoch,authority_key_id=EXCLUDED.authority_key_id,
             verified_at=EXCLUDED.verified_at`,
          [context.collectionId, context.principalId, context.keyVersion, context.epoch, bundle.authorityKeyId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return context;
    } finally {
      device.privateKey.fill(0);
      local.data.fill(0);
      local.dedup.fill(0);
      recovered?.dataKey.fill(0);
      recovered?.dedupKey.fill(0);
    }
  }

  private async currentContext(collectionId:string, query:Pick<pg.Pool, 'query'> = this.db):Promise<CurrentKeyContextRow> {
    const row = (await query.query(
      `SELECT k.collection_id,c.owner_user_id,k.key_version,k.key_epoch,k.key_origin,c.compatibility_state
         FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
        WHERE k.collection_id=$1 FOR UPDATE OF k,c`,
      [collectionId],
    )).rows[0] as CurrentKeyContextRow | undefined;
    if (!row) throw new Error('Collection key context is unavailable');
    return row;
  }
}

function sameContext(left:FilesKeyBundleContext, right:FilesKeyBundleContext):boolean {
  return left.collectionId === right.collectionId && left.principalId === right.principalId &&
    left.keyVersion === right.keyVersion && left.epoch === right.epoch;
}

function sameRowContext(row:CurrentKeyContextRow, context:FilesKeyBundleContext):boolean {
  return row.collection_id === context.collectionId && row.owner_user_id === context.principalId &&
    Number(row.key_version) === context.keyVersion && Number(row.key_epoch) === context.epoch;
}

function equal(left:Uint8Array, right:Uint8Array):boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
