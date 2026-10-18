import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  generateX25519RecipientKeyPair,
  openFilesKeyBundle,
  sealFilesKeyBundle,
  type FilesKeyBundleContext,
  type FilesKeyBundleEnvelope,
} from '@sulla/vault-crypto';

import {
  VaultFilesKeyBundleAuthority,
  type FilesAuthorityIdentityLease,
  type RegisteredFilesKeyBundle,
  type UnlockedFilesAuthorityIdentity,
} from './filesKeyBundleAuthority.js';

import type { Database } from './db.js';

function bundleId(context:FilesKeyBundleContext):string {
  return `${ context.principalId }:${ context.collectionId }:${ context.keyVersion }:${ context.epoch }`;
}

function collectionId(context:FilesKeyBundleContext):string {
  return `${ context.principalId }:${ context.collectionId }`;
}

class MemoryVaultDatabase {
  readonly envelopes = new Map<string, RegisteredFilesKeyBundle>();
  readonly current = new Map<string, FilesKeyBundleContext>();

  readonly pool = {
    connect: async() => ({ query: this.query.bind(this), release() {} }),
    query: this.query.bind(this),
  } as unknown as Database;

  private async query<T>(sql:string, values:unknown[] = []):Promise<{ rows: T[]; rowCount: number }> {
    await Promise.resolve();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 };
    }
    const context:FilesKeyBundleContext = {
      principalId: String(values[0]), collectionId: String(values[1]),
      keyVersion: Number(values[2]), epoch: Number(values[3]),
    };
    if (sql.includes('FROM files_key_bundle_envelopes') && !sql.includes('JOIN files_key_bundle_current')) {
      const bundle = this.envelopes.get(bundleId(context));
      return { rows: bundle ? [this.envelopeRow(bundle) as T] : [], rowCount: bundle ? 1 : 0 };
    }
    if (sql.includes('FROM files_key_bundle_current')) {
      const current = this.current.get(collectionId(context));
      return { rows: current ? [this.currentRow(current) as T] : [], rowCount: current ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO files_key_bundle_envelopes')) {
      const bundle:RegisteredFilesKeyBundle = {
        context,
        authorityKeyId: String(values[4]),
        envelope: structuredClone(values[5]) as FilesKeyBundleEnvelope,
      };
      if (this.envelopes.has(bundleId(context))) throw new Error('duplicate envelope');
      this.envelopes.set(bundleId(context), bundle);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO files_key_bundle_current')) {
      this.current.set(collectionId(context), { ...context });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('JOIN files_key_bundle_current')) {
      const bundle = this.envelopes.get(bundleId(context));
      const current = this.current.get(collectionId(context));
      const authorized = bundle && current && bundleId(current) === bundleId(context);
      return { rows: authorized ? [this.envelopeRow(bundle) as T] : [], rowCount: authorized ? 1 : 0 };
    }
    throw new Error(`Unexpected synthetic query: ${ sql }`);
  }

  private envelopeRow(bundle:RegisteredFilesKeyBundle):Record<string, unknown> {
    return {
      principal_id: bundle.context.principalId, collection_id: bundle.context.collectionId,
      key_version: bundle.context.keyVersion, key_epoch: bundle.context.epoch,
      authority_key_id: bundle.authorityKeyId, authority_bundle: structuredClone(bundle.envelope),
    };
  }

  private currentRow(context:FilesKeyBundleContext):Record<string, unknown> {
    return {
      principal_id: context.principalId, collection_id: context.collectionId,
      key_version: context.keyVersion, key_epoch: context.epoch,
    };
  }
}

class SyntheticUnlockedIdentity implements FilesAuthorityIdentityLease {
  private unlocked = true;
  private generation = 7;

  constructor(
    readonly principalId:string,
    readonly publicKey:string,
    readonly privateKey:Uint8Array,
  ) {}

  async withUnlockedIdentity<T>(operation:(identity:UnlockedFilesAuthorityIdentity) => Promise<T>):Promise<T> {
    if (!this.unlocked) throw new Error('Vault is locked');
    const generation = this.generation;
    return operation({
      principalId: this.principalId,
      publicKey: this.publicKey,
      privateKey: this.privateKey,
      generation,
      assertCurrent: () => {
        if (!this.unlocked || generation !== this.generation) throw new Error('Vault generation changed');
      },
    });
  }

  lock():void {
    this.unlocked = false;
    this.generation += 1;
  }
}

test('Vault authority persists immutable custody and only rewraps the current exact context', async() => {
  const authorityPair = await generateX25519RecipientKeyPair();
  const identity = new SyntheticUnlockedIdentity('principal-1', authorityPair.publicKey, authorityPair.privateKey);
  const storage = new MemoryVaultDatabase();
  const authority = new VaultFilesKeyBundleAuthority(storage.pool, identity);
  const context = { principalId: 'principal-1', collectionId: 'collection-1', keyVersion: 2, epoch: 4 };
  const original = { dataKey: randomBytes(32), dedupKey: randomBytes(32) };
  const recipient = await authority.custodyRecipient(context);
  const custody = await sealFilesKeyBundle(original, context, 'authority-custody', recipient.publicKey);
  const registered = { context, authorityKeyId: recipient.keyId, envelope: custody };

  await authority.registerBundle(registered);
  await authority.registerBundle(registered);
  assert.equal(storage.envelopes.size, 1);
  const persisted = JSON.stringify([...storage.envelopes.values()]);
  assert.equal(persisted.includes(Buffer.from(original.dataKey).toString('base64url')), false);
  assert.equal(persisted.includes(Buffer.from(original.dedupKey).toString('base64url')), false);

  const firstDevice = await generateX25519RecipientKeyPair();
  const recoveredEnvelope = await authority.authorizeDeviceRecovery({ context, devicePublicKey: firstDevice.publicKey });
  const recovered = await openFilesKeyBundle(
    recoveredEnvelope, context, 'device-recovery', firstDevice.publicKey, firstDevice.privateKey,
  );
  assert.deepEqual(Buffer.from(recovered.dataKey), Buffer.from(original.dataKey));
  assert.deepEqual(Buffer.from(recovered.dedupKey), Buffer.from(original.dedupKey));
  firstDevice.privateKey.fill(0);
  recovered.dataKey.fill(0);
  recovered.dedupKey.fill(0);

  const nextContext = { ...context, keyVersion: 3, epoch: 5 };
  const nextRecipient = await authority.custodyRecipient(nextContext);
  const nextEnvelope = await sealFilesKeyBundle(original, nextContext, 'authority-custody', nextRecipient.publicKey);
  await authority.registerBundle({ context: nextContext, authorityKeyId: nextRecipient.keyId, envelope: nextEnvelope });
  const replacementDevice = await generateX25519RecipientKeyPair();
  await assert.rejects(
    authority.authorizeDeviceRecovery({ context, devicePublicKey: replacementDevice.publicKey }),
    /not authorized for this exact context/,
  );
  await assert.rejects(
    authority.authorizeDeviceRecovery({ context: { ...nextContext, principalId: 'principal-2' }, devicePublicKey: replacementDevice.publicKey }),
    /not the unlocked Vault principal/,
  );
  replacementDevice.privateKey.fill(0);

  identity.lock();
  await assert.rejects(authority.custodyRecipient(nextContext), /locked/);
  await assert.rejects(
    authority.authorizeDeviceRecovery({ context: nextContext, devicePublicKey: authorityPair.publicKey }),
    /locked/,
  );
  authorityPair.privateKey.fill(0);
  original.dataKey.fill(0);
  original.dedupKey.fill(0);
});
