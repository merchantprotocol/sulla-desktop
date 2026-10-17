import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  generateX25519RecipientKeyPair,
  rewrapFilesKeyBundleForDevice,
  sealFilesKeyBundle,
  type FilesKeyBundleContext,
  type FilesKeyBundleEnvelope,
} from '@sulla/vault-crypto';

import { decrypt, encrypt, type Envelope } from './crypto.js';
import { FilesKeyBundleRecovery, type FilesKeyBundleAuthority, type StoredFilesKeyBundle } from './keyBundleRecovery.js';

import type { FilesKeyring } from './keyring.js';
import type pg from 'pg';

interface WrappedKeys { data: Envelope; dedup: Envelope }

class SyntheticAuthority implements FilesKeyBundleAuthority {
  readonly pairPromise = generateX25519RecipientKeyPair();
  readonly bundles = new Map<string, StoredFilesKeyBundle>();
  allowedPrincipal = 'principal-1';
  currentEpoch = 4;
  recipientCalls = 0;
  registerCalls = 0;

  private id(context:FilesKeyBundleContext):string {
    return `${ context.principalId }:${ context.collectionId }:${ context.keyVersion }:${ context.epoch }`;
  }

  async custodyRecipient(_context:FilesKeyBundleContext):Promise<{ keyId: string; publicKey: string }> {
    this.recipientCalls++;
    return { keyId: 'authority-key-1', publicKey: (await this.pairPromise).publicKey };
  }

  async registerBundle(bundle:StoredFilesKeyBundle):Promise<void> {
    await Promise.resolve();
    this.registerCalls++;
    const existing = this.bundles.get(this.id(bundle.context));
    if (existing && JSON.stringify(existing) !== JSON.stringify(bundle)) throw new Error('conflicting authority bundle');
    this.bundles.set(this.id(bundle.context), bundle);
  }

  async authorizeDeviceRecovery(request:{ context: FilesKeyBundleContext; devicePublicKey: string }):Promise<FilesKeyBundleEnvelope> {
    if (request.context.principalId !== this.allowedPrincipal) throw new Error('unauthorized principal');
    if (request.context.epoch !== this.currentEpoch) throw new Error('stale epoch');
    const stored = this.bundles.get(this.id(request.context));
    if (!stored) throw new Error('unknown bundle');
    const pair = await this.pairPromise;
    return rewrapFilesKeyBundleForDevice(
      stored.envelope,
      request.context,
      pair.publicKey,
      pair.privateKey,
      request.devicePublicKey,
    );
  }
}

function database(row:{ context: FilesKeyBundleContext; envelope: FilesKeyBundleEnvelope }, owner = row.context.principalId):pg.Pool {
  return {
    async query(sql:string, values?:unknown[]) {
      await Promise.resolve();
      if (sql.includes('JOIN files_collection_key_bundles')) {
        return {
          rows: [{
            collection_id:    row.context.collectionId,
            principal_id:     values?.[0],
            key_version:      row.context.keyVersion,
            key_epoch:        row.context.epoch,
            authority_key_id: 'authority-key-1',
            authority_bundle: row.envelope,
          }],
        };
      }
      if (sql.includes('FROM files_collection_keys')) {
        return {
          rows: [{
            collection_id: row.context.collectionId, key_origin: 'random', owner_user_id: owner, compatibility_state: 'native',
          }],
        };
      }
      throw new Error(`Unexpected query: ${ sql }`);
    },
  } as unknown as pg.Pool;
}

function enrollmentDatabase(context:FilesKeyBundleContext):{ db: pg.Pool; rows: Map<string, StoredFilesKeyBundle> } {
  const rows = new Map<string, StoredFilesKeyBundle>();
  const id = (value:FilesKeyBundleContext) => `${ value.collectionId }:${ value.principalId }:${ value.keyVersion }:${ value.epoch }`;
  const db = {
    async query(sql:string, values:unknown[] = []) {
      await Promise.resolve();
      if (sql.includes('FROM files_collection_keys k JOIN collections')) {
        return {
          rows: values[0] === context.collectionId
            ? [{
              collection_id:       context.collectionId,
              owner_user_id:       context.principalId,
              compatibility_state: 'native',
              key_origin:          'random',
              key_version:         context.keyVersion,
              key_epoch:           context.epoch,
            }]
            : [],
        };
      }
      if (sql.includes('FROM files_collection_key_bundles')) {
        const found = rows.get(id(context));
        return {
          rows: found
            ? [{
              collection_id:    context.collectionId,
              principal_id:     context.principalId,
              key_version:      context.keyVersion,
              key_epoch:        context.epoch,
              authority_key_id: found.authorityKeyId,
              authority_bundle: found.envelope,
            }]
            : [],
        };
      }
      if (sql.startsWith('INSERT INTO files_collection_key_bundles')) {
        if (!rows.has(id(context))) {
          rows.set(id(context), {
            context: { ...context }, authorityKeyId: String(values[4]), envelope: values[5] as FilesKeyBundleEnvelope,
          });
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE files_collection_key_bundles')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${ sql }`);
    },
  } as unknown as pg.Pool;
  return { db, rows };
}

test('enrollment binds owner/version/epoch from collection metadata and reuses the persisted winner', async() => {
  const authority = new SyntheticAuthority();
  const context = { collectionId: 'collection-1', principalId: 'principal-1', keyVersion: 3, epoch: 4 };
  const storage = enrollmentDatabase(context);
  const material = { data: randomBytes(32), dedup: randomBytes(32) };
  const keyring = { async copyKeys() { await Promise.resolve(); return { data: Buffer.from(material.data), dedup: Buffer.from(material.dedup) } } } as unknown as FilesKeyring;
  const recovery = new FilesKeyBundleRecovery(storage.db, keyring, authority);

  const first = await recovery.enrollCollection(context.collectionId);
  const second = await recovery.enrollCollection(context.collectionId);
  assert.deepEqual(first, second);
  assert.deepEqual(first.context, context);
  assert.equal(storage.rows.size, 1);
  assert.equal(authority.recipientCalls, 1);
  assert.equal(authority.registerCalls, 2);
  await assert.rejects(recovery.enrollCollection('caller-invented-collection'), /unavailable/);
});

test('synthetic fresh-device restore rewraps authorized keys under the replacement master', async() => {
  const authority = new SyntheticAuthority();
  const context = { collectionId: 'collection-1', principalId: 'principal-1', keyVersion: 2, epoch: 4 };
  const original = { data: randomBytes(32), dedup: randomBytes(32) };
  const recipient = await authority.custodyRecipient(context);
  const custody = await sealFilesKeyBundle(
    { dataKey: original.data, dedupKey: original.dedup },
    context,
    'authority-custody',
    recipient.publicKey,
  );
  await authority.registerBundle({ context, authorityKeyId: recipient.keyId, envelope: custody });
  const replacementMaster = randomBytes(32);
  const oldMaster = randomBytes(32);
  let wrapped:WrappedKeys | undefined;
  const keyring = {
    async installRecoveredMaster(master:Buffer, recovered:ReadonlyMap<string, { data: Uint8Array; dedup: Uint8Array }>) {
      await Promise.resolve();
      const keys = recovered.get(context.collectionId);
      assert.ok(keys);
      wrapped = {
        data:  await encrypt(keys.data, master, `sulla:files:data-key:v1:${ context.collectionId }`),
        dedup: await encrypt(keys.dedup, master, `sulla:files:dedup-key:v1:${ context.collectionId }`),
      };
    },
  } as unknown as FilesKeyring;
  const recovery = new FilesKeyBundleRecovery(database({ context, envelope: custody }), keyring, authority);

  assert.equal(await recovery.recoverDeviceMaster(replacementMaster, context.principalId), 1);
  assert.ok(wrapped);
  assert.deepEqual(Buffer.from(await decrypt(wrapped.data, replacementMaster, `sulla:files:data-key:v1:${ context.collectionId }`)), original.data);
  assert.deepEqual(Buffer.from(await decrypt(wrapped.dedup, replacementMaster, `sulla:files:dedup-key:v1:${ context.collectionId }`)), original.dedup);
  await assert.rejects(decrypt(wrapped.data, oldMaster, `sulla:files:data-key:v1:${ context.collectionId }`));
});

test('synthetic authority rejects unauthorized principals and stale epochs before local rewrap', async() => {
  const authority = new SyntheticAuthority();
  const context = { collectionId: 'collection-1', principalId: 'principal-2', keyVersion: 1, epoch: 3 };
  const recipient = await authority.custodyRecipient(context);
  const custody = await sealFilesKeyBundle(
    { dataKey: randomBytes(32), dedupKey: randomBytes(32) },
    context,
    'authority-custody',
    recipient.publicKey,
  );
  await authority.registerBundle({ context, authorityKeyId: recipient.keyId, envelope: custody });
  let installed = false;
  const keyring = { async installRecoveredMaster() { await Promise.resolve(); installed = true } } as unknown as FilesKeyring;
  const recovery = new FilesKeyBundleRecovery(database({ context, envelope: custody }), keyring, authority);

  await assert.rejects(recovery.recoverDeviceMaster(randomBytes(32), context.principalId), /unauthorized principal/);
  assert.equal(installed, false);
  authority.allowedPrincipal = context.principalId;
  await assert.rejects(recovery.recoverDeviceMaster(randomBytes(32), context.principalId), /stale epoch/);
  assert.equal(installed, false);
});

test('replacement-master recovery rejects mixed owner principals before authority rewrap', async() => {
  const authority = new SyntheticAuthority();
  const context = { collectionId: 'collection-1', principalId: 'principal-1', keyVersion: 1, epoch: 4 };
  const recipient = await authority.custodyRecipient(context);
  const custody = await sealFilesKeyBundle(
    { dataKey: randomBytes(32), dedupKey: randomBytes(32) }, context, 'authority-custody', recipient.publicKey,
  );
  let installed = false;
  const keyring = { async installRecoveredMaster() { await Promise.resolve(); installed = true } } as unknown as FilesKeyring;
  const recovery = new FilesKeyBundleRecovery(database({ context, envelope: custody }, 'another-owner'), keyring, authority);
  await assert.rejects(recovery.recoverDeviceMaster(randomBytes(32), context.principalId), /one owner principal/);
  assert.equal(installed, false);
});
