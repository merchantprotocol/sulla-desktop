import assert from 'node:assert/strict';
import test from 'node:test';

import {
  generateKey,
  generateX25519RecipientKeyPair,
  openFilesKeyBundle,
  rewrapFilesKeyBundleForDevice,
  sealFilesKeyBundle,
  type FilesKeyBundleContext,
} from './index.js';

const context: FilesKeyBundleContext = {
  collectionId: 'collection-1',
  principalId:  'principal-1',
  keyVersion:   1,
  epoch:        7,
};

test('Files collection keys recover through an authorized fresh-device envelope', async() => {
  const authority = await generateX25519RecipientKeyPair();
  const device = await generateX25519RecipientKeyPair();
  const material = { dataKey: await generateKey(), dedupKey: await generateKey() };
  const custody = await sealFilesKeyBundle(material, context, 'authority-custody', authority.publicKey);
  const recovery = await rewrapFilesKeyBundleForDevice(
    custody,
    context,
    authority.publicKey,
    authority.privateKey,
    device.publicKey,
  );
  const restored = await openFilesKeyBundle(recovery, context, 'device-recovery', device.publicKey, device.privateKey);

  assert.deepEqual(restored.dataKey, material.dataKey);
  assert.deepEqual(restored.dedupKey, material.dedupKey);
  material.dataKey.fill(0); material.dedupKey.fill(0);
  restored.dataKey.fill(0); restored.dedupKey.fill(0);
  authority.privateKey.fill(0); device.privateKey.fill(0);
});

test('Files key bundles reject wrong principal, collection, epoch, purpose and tampering', async() => {
  const authority = await generateX25519RecipientKeyPair();
  const material = { dataKey: await generateKey(), dedupKey: await generateKey() };
  const envelope = await sealFilesKeyBundle(material, context, 'authority-custody', authority.publicKey);
  const reject = (overrides: Partial<FilesKeyBundleContext>, candidate = envelope) => assert.rejects(
    openFilesKeyBundle(candidate, { ...context, ...overrides }, 'authority-custody', authority.publicKey, authority.privateKey),
  );

  await reject({ principalId: 'principal-2' });
  await reject({ collectionId: 'collection-2' });
  await reject({ epoch: 8 });
  await assert.rejects(openFilesKeyBundle(envelope, context, 'device-recovery', authority.publicKey, authority.privateKey));
  const first = envelope.dataKey.ciphertext.startsWith('A') ? 'B' : 'A';
  await reject({}, { ...envelope, dataKey: { ...envelope.dataKey, ciphertext: `${ first }${ envelope.dataKey.ciphertext.slice(1) }` } });
  material.dataKey.fill(0); material.dedupKey.fill(0); authority.privateKey.fill(0);
});
