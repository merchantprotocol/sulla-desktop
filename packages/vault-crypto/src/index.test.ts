import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUserKey,
  createUserKeyPair,
  decryptWithKey,
  decryptItemText,
  deriveMasterKey,
  encryptItem,
  generateKey,
  itemAssociatedData,
  unwrapOrgKeyForMember,
  unwrapItemKeyForAgent,
  unwrapUserKey,
  wrapOrgKeyForMember,
} from './index.js';

test('master key wrapping and item encryption round-trip', async() => {
  const master = await deriveMasterKey('correct horse battery staple');
  const { userKey, encryptedUserKey } = await createUserKey(master.key);
  const restoredUserKey = await unwrapUserKey(encryptedUserKey, master.key);
  const agent = await createUserKeyPair(await generateKey());
  const plaintext = JSON.stringify({ username: 'jonathon', password: 'secret' });
  const context = { itemId: 'item-1', ownerId: 'user-1' };
  const item = await encryptItem(plaintext, restoredUserKey, context, agent.publicKey);

  assert.equal(await decryptItemText(item, userKey, context), plaintext);
  assert.ok(item.agentWrappedItemKey);
  const agentItemKey = await unwrapItemKeyForAgent(item.agentWrappedItemKey, agent.publicKey, agent.privateKey);
  assert.equal(new TextDecoder().decode(
    await decryptWithKey(item.ciphertext, agentItemKey, itemAssociatedData('ciphertext', context)),
  ), plaintext);
});

test('item ciphertext cannot be moved to another item or owner', async() => {
  const ownerKey = await generateKey();
  const first = await encryptItem('first', ownerKey, { itemId: 'item-1', ownerId: 'user-1' });

  await assert.rejects(
    decryptItemText(first, ownerKey, { itemId: 'item-2', ownerId: 'user-1' }),
  );
  await assert.rejects(
    decryptItemText(first, ownerKey, { itemId: 'item-1', ownerId: 'user-2' }),
  );
});

test('an organization key can be shared to a second member', async() => {
  const memberUserKey = await generateKey();
  const member = await createUserKeyPair(memberUserKey);
  const orgKey = await generateKey();
  const wrapped = await wrapOrgKeyForMember(orgKey, member.publicKey);
  const restored = await unwrapOrgKeyForMember(wrapped, member.publicKey, member.privateKey);

  assert.deepEqual(restored, orgKey);
});
