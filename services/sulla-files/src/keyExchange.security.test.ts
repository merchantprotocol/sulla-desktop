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

import { type FilesKeyBundleAuthority, type FilesKeyBundleRecovery, type StoredFilesKeyBundle } from './keyBundleRecovery.js';
import { SecureCollectionKeyExchange } from './keyExchange.js';

import type { FilesKeyring } from './keyring.js';
import type pg from 'pg';

test('remote recoverability is recorded only after exact-context keys round-trip through authority custody', async() => {
  const context:FilesKeyBundleContext = { collectionId: 'collection-1', principalId: 'principal-1', keyVersion: 7, epoch: 3 };
  const local = { data: randomBytes(32), dedup: randomBytes(32) };
  const custody = await generateX25519RecipientKeyPair();
  const envelope = await sealFilesKeyBundle(
    { dataKey: local.data, dedupKey: local.dedup }, context, 'authority-custody', custody.publicKey,
  );
  const bundle:StoredFilesKeyBundle = { context, authorityKeyId: 'authority-key-1', envelope };
  let malicious = true;
  let proofWrites = 0;

  const authority:FilesKeyBundleAuthority = {
    custodyRecipient() { return Promise.resolve({ keyId: bundle.authorityKeyId, publicKey: custody.publicKey }) },
    registerBundle() { return Promise.resolve() },
    async authorizeDeviceRecovery(request):Promise<FilesKeyBundleEnvelope> {
      const source = malicious
        ? await sealFilesKeyBundle({ dataKey: randomBytes(32), dedupKey: randomBytes(32) }, context, 'authority-custody', custody.publicKey)
        : envelope;
      return rewrapFilesKeyBundleForDevice(source, context, custody.publicKey, custody.privateKey, request.devicePublicKey);
    },
  };
  const transaction = {
    query(sql:string) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [], rowCount: 0 });
      if (sql.includes('FROM files_collection_keys')) return Promise.resolve({ rows: [keyRow(context)], rowCount: 1 });
      if (sql.startsWith('INSERT INTO files_remote_key_recovery')) { proofWrites++; return Promise.resolve({ rows: [], rowCount: 1 }) }
      return Promise.reject(new Error(`Unexpected transaction query: ${ sql }`));
    },
    release() {},
  };
  const db = {
    query(sql:string) {
      if (sql.includes('FROM files_collection_keys')) return Promise.resolve({ rows: [keyRow(context)], rowCount: 1 });
      return Promise.reject(new Error(`Unexpected pool query: ${ sql }`));
    },
    connect() { return Promise.resolve(transaction) },
  } as unknown as pg.Pool;
  const keyring = {
    copyKeys() { return Promise.resolve({ data: Buffer.from(local.data), dedup: Buffer.from(local.dedup) }) },
  } as unknown as FilesKeyring;
  const recovery = { enrollCollection() { return Promise.resolve(bundle) } } as unknown as FilesKeyBundleRecovery;
  const exchange = new SecureCollectionKeyExchange(db, keyring, authority, recovery);

  await assert.rejects(exchange.verifyRemoteRecoverability(context.collectionId), /different collection keys/);
  assert.equal(proofWrites, 0);
  malicious = false;
  assert.deepEqual(await exchange.verifyRemoteRecoverability(context.collectionId), context);
  assert.equal(proofWrites, 1);
  custody.privateKey.fill(0);
});

function keyRow(context:FilesKeyBundleContext) {
  return {
    collection_id:       context.collectionId,
    owner_user_id:       context.principalId,
    key_version:         context.keyVersion,
    key_epoch:           context.epoch,
    key_origin:          'random',
    compatibility_state: 'native',
  };
}
