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
  const item = await encryptItem(plaintext, restoredUserKey, agent.publicKey);

  assert.equal(await decryptItemText(item, userKey), plaintext);
  assert.ok(item.agentWrappedItemKey);
  const agentItemKey = await unwrapItemKeyForAgent(item.agentWrappedItemKey, agent.publicKey, agent.privateKey);
  assert.equal(new TextDecoder().decode(await decryptWithKey(item.ciphertext, agentItemKey, 'sulla:item:v1')), plaintext);
});

test('an organization key can be shared to a second member', async() => {
  const memberUserKey = await generateKey();
  const member = await createUserKeyPair(memberUserKey);
  const orgKey = await generateKey();
  const wrapped = await wrapOrgKeyForMember(orgKey, member.publicKey);
  const restored = await unwrapOrgKeyForMember(wrapped, member.publicKey, member.privateKey);

  assert.deepEqual(restored, orgKey);
});
