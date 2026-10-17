import {
  generateX25519RecipientKeyPair,
  openFilesKeyBundle,
  sealFilesKeyBundle,
  type Base64,
  type FilesKeyBundleContext,
  type FilesKeyBundleEnvelope,
} from '@sulla/vault-crypto';

import type { FilesKeyring } from './keyring.js';
import type pg from 'pg';

export interface StoredFilesKeyBundle {
  context:        FilesKeyBundleContext;
  authorityKeyId: string;
  envelope:       FilesKeyBundleEnvelope;
}

/** Implemented by Vault. It owns authorization and custody-key plaintext. */
export interface FilesKeyBundleAuthority {
  custodyRecipient(context:FilesKeyBundleContext):Promise<{ keyId: string; publicKey: Base64 }>;
  registerBundle(bundle:StoredFilesKeyBundle):Promise<void>;
  authorizeDeviceRecovery(request:{ context: FilesKeyBundleContext; devicePublicKey: Base64 }):Promise<FilesKeyBundleEnvelope>;
}

interface BundleRow {
  collection_id:    string;
  principal_id:     string;
  key_version:      number;
  key_epoch:        number;
  authority_key_id: string;
  authority_bundle: FilesKeyBundleEnvelope;
}

interface CollectionKeyRow {
  collection_id:       string;
  owner_user_id:       string;
  compatibility_state: string;
  key_origin:          string;
  key_version:         number;
  key_epoch:           number;
}

function rowBundle(row:BundleRow):StoredFilesKeyBundle {
  return {
    context: {
      collectionId: row.collection_id,
      principalId:  row.principal_id,
      keyVersion:   Number(row.key_version),
      epoch:        Number(row.key_epoch),
    },
    authorityKeyId: row.authority_key_id,
    envelope:       row.authority_bundle,
  };
}

export class FilesKeyBundleRecovery {
  constructor(
    private readonly db:pg.Pool,
    private readonly keyring:FilesKeyring,
    private readonly authority:FilesKeyBundleAuthority,
  ) {}

  async enrollCollection(collectionId:string):Promise<StoredFilesKeyBundle> {
    const row = (await this.db.query(
      `SELECT k.collection_id,c.owner_user_id,c.compatibility_state,k.key_origin,k.key_version,k.key_epoch
         FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
        WHERE k.collection_id=$1`,
      [collectionId],
    )).rows[0] as CollectionKeyRow | undefined;
    if (!row) throw new Error('Collection key unavailable');
    if (row.key_origin !== 'random' || row.compatibility_state !== 'native') {
      throw new Error('Legacy Files keys require the separate secure import flow');
    }
    const context:FilesKeyBundleContext = {
      collectionId: row.collection_id,
      principalId:  row.owner_user_id,
      keyVersion:   Number(row.key_version),
      epoch:        Number(row.key_epoch),
    };
    const existing = await this.storedBundle(context);
    if (existing) {
      await this.registerPersisted(existing);
      return existing;
    }
    const recipient = await this.authority.custodyRecipient(context);
    const keys = await this.keyring.copyKeys(collectionId);
    try {
      const candidate:StoredFilesKeyBundle = {
        context:        { ...context },
        authorityKeyId: recipient.keyId,
        envelope:       await sealFilesKeyBundle(
          { dataKey: keys.data, dedupKey: keys.dedup },
          context,
          'authority-custody',
          recipient.publicKey,
        ),
      };
      await this.db.query(
        `INSERT INTO files_collection_key_bundles
          (collection_id,principal_id,key_version,key_epoch,authority_key_id,authority_bundle)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [context.collectionId, context.principalId, context.keyVersion, context.epoch,
          recipient.keyId, candidate.envelope],
      );
      // Re-read the immutable winner. Concurrent enrollments may have produced
      // different randomized candidates, but only the persisted envelope is
      // ever registered with Vault.
      const persisted = await this.storedBundle(context);
      if (!persisted) throw new Error('Files recovery bundle was not persisted');
      await this.registerPersisted(persisted);
      return persisted;
    } finally {
      keys.data.fill(0); keys.dedup.fill(0);
    }
  }

  private async storedBundle(context:FilesKeyBundleContext):Promise<StoredFilesKeyBundle | undefined> {
    const row = (await this.db.query(
      `SELECT collection_id,principal_id,key_version,key_epoch,authority_key_id,authority_bundle
         FROM files_collection_key_bundles
        WHERE collection_id=$1 AND principal_id=$2 AND key_version=$3 AND key_epoch=$4`,
      [context.collectionId, context.principalId, context.keyVersion, context.epoch],
    )).rows[0] as BundleRow | undefined;
    return row ? rowBundle(row) : undefined;
  }

  private async registerPersisted(bundle:StoredFilesKeyBundle):Promise<void> {
    await this.authority.registerBundle(bundle);
    await this.db.query(
      `UPDATE files_collection_key_bundles SET authority_registered_at=COALESCE(authority_registered_at,NOW())
        WHERE collection_id=$1 AND principal_id=$2 AND key_version=$3 AND key_epoch=$4`,
      [bundle.context.collectionId, bundle.context.principalId, bundle.context.keyVersion, bundle.context.epoch],
    );
  }

  async recoverDeviceMaster(master:Buffer, principalId:string):Promise<number> {
    if (!principalId) throw new Error('Files recovery requires a principal');
    const rows = (await this.db.query(
      `SELECT b.collection_id,b.principal_id,b.key_version,b.key_epoch,b.authority_key_id,b.authority_bundle
         FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id
         JOIN files_collection_key_bundles b ON b.collection_id=k.collection_id
          AND b.principal_id=c.owner_user_id AND b.key_version=k.key_version AND b.key_epoch=k.key_epoch
        WHERE c.owner_user_id=$1 AND c.compatibility_state='native' AND k.key_origin='random'
        ORDER BY b.collection_id`,
      [principalId],
    )).rows as BundleRow[];
    const collectionRows = (await this.db.query(
      `SELECT k.collection_id,k.key_origin,c.owner_user_id,c.compatibility_state
         FROM files_collection_keys k JOIN collections c ON c.id=k.collection_id ORDER BY k.collection_id`,
    )).rows as { collection_id: string; key_origin: string; owner_user_id: string; compatibility_state: string }[];
    if (collectionRows.some(row => row.key_origin !== 'random' || row.compatibility_state !== 'native')) {
      throw new Error('Legacy Files keys require the separate secure import flow');
    }
    if (collectionRows.some(row => row.owner_user_id !== principalId)) {
      throw new Error('Files device recovery currently requires one owner principal for every local collection');
    }
    if (rows.length === 0 || rows.length !== collectionRows.length ||
        collectionRows.some((row, index) => row.collection_id !== rows[index]?.collection_id)) {
      throw new Error('Files recovery is incomplete; no local keys were changed');
    }

    const device = await generateX25519RecipientKeyPair();
    const recovered = new Map<string, { data: Uint8Array; dedup: Uint8Array }>();
    try {
      for (const row of rows) {
        const stored = rowBundle(row);
        // Vault resolves its own registered envelope by this exact context;
        // Files never supplies an envelope as an authorization assertion.
        const deviceEnvelope = await this.authority.authorizeDeviceRecovery({ context: stored.context, devicePublicKey: device.publicKey });
        const keys = await openFilesKeyBundle(
          deviceEnvelope,
          stored.context,
          'device-recovery',
          device.publicKey,
          device.privateKey,
        );
        recovered.set(stored.context.collectionId, { data: keys.dataKey, dedup: keys.dedupKey });
      }
      await this.keyring.installRecoveredMaster(master, recovered);
      return recovered.size;
    } finally {
      device.privateKey.fill(0);
      for (const keys of recovered.values()) { keys.data.fill(0); keys.dedup.fill(0) }
    }
  }
}
