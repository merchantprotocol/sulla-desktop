import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  openFilesKeyBundle,
  rewrapFilesKeyBundleForDevice,
  type Base64,
  type FilesKeyBundleContext,
  type FilesKeyBundleEnvelope,
} from '@sulla/vault-crypto';

import type { Database } from './db.js';

export interface RegisteredFilesKeyBundle {
  context:        FilesKeyBundleContext;
  authorityKeyId: string;
  envelope:       FilesKeyBundleEnvelope;
}

/**
 * A lease is issued by LocalVaultAuthority while it is unlocked. Its
 * implementation lends an erasable private-key copy and verifies the generation
 * again before returning, so lock stays responsive and no stale response or key
 * reference survives a Vault generation.
 */
export interface UnlockedFilesAuthorityIdentity {
  principalId: string;
  publicKey:   Base64;
  privateKey:  Uint8Array;
  generation:  number;
  assertCurrent(): void;
}

export interface FilesAuthorityIdentityLease {
  withUnlockedIdentity<T>(operation:(identity:UnlockedFilesAuthorityIdentity) => Promise<T>):Promise<T>;
}

export class VaultFilesKeyBundleError extends Error {
  constructor(public readonly code:string, public readonly status:number, message:string) {
    super(message);
    this.name = 'VaultFilesKeyBundleError';
  }
}

interface CurrentRow {
  principal_id:  string;
  collection_id: string;
  key_version:   number | string;
  key_epoch:     number | string;
}

interface EnvelopeRow extends CurrentRow {
  authority_key_id: string;
  authority_bundle: FilesKeyBundleEnvelope;
}

function assertContext(context:FilesKeyBundleContext):void {
  if (!context || typeof context.collectionId !== 'string' || !context.collectionId ||
      typeof context.principalId !== 'string' || !context.principalId ||
      !Number.isSafeInteger(context.keyVersion) || context.keyVersion < 1 ||
      !Number.isSafeInteger(context.epoch) || context.epoch < 1) {
    throw new VaultFilesKeyBundleError('invalid_context', 400, 'Files key bundle context is invalid');
  }
}

function sameContext(left:FilesKeyBundleContext, right:FilesKeyBundleContext):boolean {
  return left.collectionId === right.collectionId && left.principalId === right.principalId &&
    left.keyVersion === right.keyVersion && left.epoch === right.epoch;
}

function authorityKeyId(identity:Pick<UnlockedFilesAuthorityIdentity, 'principalId' | 'publicKey'>):string {
  const fingerprint = createHash('sha256').update(identity.publicKey).digest('base64url');
  return `vault-user-x25519:v1:${ identity.principalId }:${ fingerprint }`;
}

function assertUnlockedPrincipal(identity:UnlockedFilesAuthorityIdentity, context:FilesKeyBundleContext):void {
  assertContext(context);
  if (context.principalId !== identity.principalId) {
    throw new VaultFilesKeyBundleError('principal_denied', 403, 'Files recovery principal is not the unlocked Vault principal');
  }
  identity.assertCurrent();
}

function strictlyAdvances(current:CurrentRow, context:FilesKeyBundleContext):boolean {
  const version = Number(current.key_version);
  const epoch = Number(current.key_epoch);
  return context.keyVersion >= version && context.epoch >= epoch &&
    (context.keyVersion > version || context.epoch > epoch);
}

function rowContext(row:CurrentRow):FilesKeyBundleContext {
  return {
    principalId:  row.principal_id,
    collectionId: row.collection_id,
    keyVersion:   Number(row.key_version),
    epoch:        Number(row.key_epoch),
  };
}

export class VaultFilesKeyBundleAuthority {
  constructor(
    private readonly db:Database,
    private readonly identityLease:FilesAuthorityIdentityLease,
  ) {}

  async unlockedPrincipal():Promise<{ principalId: string; generation: number }> {
    return this.identityLease.withUnlockedIdentity(identity => {
      identity.assertCurrent();
      return Promise.resolve({ principalId: identity.principalId, generation: identity.generation });
    });
  }

  async custodyRecipient(context:FilesKeyBundleContext):Promise<{ keyId: string; publicKey: Base64 }> {
    return this.identityLease.withUnlockedIdentity(identity => {
      assertUnlockedPrincipal(identity, context);
      return Promise.resolve({ keyId: authorityKeyId(identity), publicKey: identity.publicKey });
    });
  }

  async registerBundle(bundle:RegisteredFilesKeyBundle):Promise<void> {
    return this.identityLease.withUnlockedIdentity(async identity => {
      assertUnlockedPrincipal(identity, bundle.context);
      const expectedKeyId = authorityKeyId(identity);
      if (bundle.authorityKeyId !== expectedKeyId || bundle.envelope.purpose !== 'authority-custody' ||
          !sameContext(bundle.envelope.context, bundle.context)) {
        throw new VaultFilesKeyBundleError('invalid_bundle', 400, 'Files custody bundle does not match the unlocked Vault authority');
      }

      // Prove that this immutable envelope was actually sealed to the current
      // Vault identity before accepting it. Plaintext exists only in memory and
      // is erased immediately.
      const material = await openFilesKeyBundle(
        bundle.envelope,
        bundle.context,
        'authority-custody',
        identity.publicKey,
        identity.privateKey,
      );
      material.dataKey.fill(0);
      material.dedupKey.fill(0);
      identity.assertCurrent();

      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`sulla:files:key-bundle:${ bundle.context.principalId }:${ bundle.context.collectionId }`],
        );
        const existing = (await client.query<EnvelopeRow>(
          `SELECT principal_id,collection_id,key_version,key_epoch,authority_key_id,authority_bundle
             FROM files_key_bundle_envelopes
            WHERE principal_id=$1 AND collection_id=$2 AND key_version=$3 AND key_epoch=$4`,
          [bundle.context.principalId, bundle.context.collectionId, bundle.context.keyVersion, bundle.context.epoch],
        )).rows[0];
        if (existing) {
          if (existing.authority_key_id !== bundle.authorityKeyId ||
              !isDeepStrictEqual(existing.authority_bundle, bundle.envelope)) {
            throw new VaultFilesKeyBundleError('bundle_conflict', 409, 'Conflicting immutable Files custody bundle');
          }
          const current = (await client.query<CurrentRow>(
            `SELECT principal_id,collection_id,key_version,key_epoch FROM files_key_bundle_current
              WHERE principal_id=$1 AND collection_id=$2 FOR UPDATE`,
            [bundle.context.principalId, bundle.context.collectionId],
          )).rows[0];
          if (!current || !sameContext(rowContext(current), bundle.context)) {
            throw new VaultFilesKeyBundleError('stale_context', 409, 'Files custody bundle is not the current authorized generation');
          }
        } else {
          const current = (await client.query<CurrentRow>(
            `SELECT principal_id,collection_id,key_version,key_epoch FROM files_key_bundle_current
              WHERE principal_id=$1 AND collection_id=$2 FOR UPDATE`,
            [bundle.context.principalId, bundle.context.collectionId],
          )).rows[0];
          if (current && !strictlyAdvances(current, bundle.context)) {
            throw new VaultFilesKeyBundleError('stale_context', 409, 'Files custody bundle version or epoch is stale');
          }
          await client.query(
            `INSERT INTO files_key_bundle_envelopes
              (principal_id,collection_id,key_version,key_epoch,authority_key_id,authority_bundle)
             VALUES($1,$2,$3,$4,$5,$6)`,
            [bundle.context.principalId, bundle.context.collectionId, bundle.context.keyVersion,
              bundle.context.epoch, bundle.authorityKeyId, bundle.envelope],
          );
          await client.query(
            `INSERT INTO files_key_bundle_current(principal_id,collection_id,key_version,key_epoch)
             VALUES($1,$2,$3,$4)
             ON CONFLICT (principal_id,collection_id) DO UPDATE SET
               key_version=EXCLUDED.key_version,key_epoch=EXCLUDED.key_epoch,updated_at=now()`,
            [bundle.context.principalId, bundle.context.collectionId,
              bundle.context.keyVersion, bundle.context.epoch],
          );
        }
        identity.assertCurrent();
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async authorizeDeviceRecovery(request:{
    context:         FilesKeyBundleContext;
    devicePublicKey: Base64;
  }):Promise<FilesKeyBundleEnvelope> {
    return this.identityLease.withUnlockedIdentity(async identity => {
      assertUnlockedPrincipal(identity, request.context);
      if (typeof request.devicePublicKey !== 'string' || !request.devicePublicKey) {
        throw new VaultFilesKeyBundleError('invalid_device_key', 400, 'Files recovery device key is invalid');
      }
      const row = (await this.db.query<EnvelopeRow>(
        `SELECT e.principal_id,e.collection_id,e.key_version,e.key_epoch,e.authority_key_id,e.authority_bundle
           FROM files_key_bundle_envelopes e
           JOIN files_key_bundle_current c USING(principal_id,collection_id,key_version,key_epoch)
          WHERE e.principal_id=$1 AND e.collection_id=$2 AND e.key_version=$3 AND e.key_epoch=$4`,
        [request.context.principalId, request.context.collectionId,
          request.context.keyVersion, request.context.epoch],
      )).rows[0];
      if (row?.authority_key_id !== authorityKeyId(identity) ||
          !sameContext(rowContext(row), request.context)) {
        throw new VaultFilesKeyBundleError('context_denied', 403, 'Files recovery bundle is not authorized for this exact context');
      }
      const envelope = await rewrapFilesKeyBundleForDevice(
        row.authority_bundle,
        request.context,
        identity.publicKey,
        identity.privateKey,
        request.devicePublicKey,
      );
      identity.assertCurrent();
      return envelope;
    });
  }
}

export const filesKeyBundleAuthorityTestHooks = { authorityKeyId };
