// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUserKey,
  createUserKeyPair,
  decryptWithKey,
  decryptItemText,
  deriveAccountAuthHash,
  deriveMasterKey,
  encryptItem,
  generateKey,
  itemAssociatedData,
  unwrapOrgKeyForMember,
  unwrapItemKeyForAgent,
  unwrapUserKey,
  wrapOrgKeyForMember,
} from './index.js';


test('account auth derivation matches the shared ACCOUNT-AUTH-V1 known-answer vector', async() => {
  const master = await deriveMasterKey(
    'Sulla KAT password · account auth v1',
    'AAECAwQFBgcICQoLDA0ODw',
    { memoryBytes: 67_108_864, operations: 3 },
  );
  try {
    assert.equal(await deriveAccountAuthHash(master.key), 'ib7ZZX_sM-TmLPJgvs2rUYxS6GG_gCvmF_9Gm_6W108');
  } finally {
    master.key.fill(0);
  }
});

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

test('agent policy blocks only-me, over-level, expired and off-site use', async () => {
  const { agentPolicyAllows, agentPolicyFromLegacyLlmAccess, DEFAULT_AGENT_POLICY } = await import('./itemSchema.js');
  const policy = { ...DEFAULT_AGENT_POLICY, mode: 'agents' as const, level: 'autofill' as const, agents: ['sulla'], sites: ['github.com'] };
  assert.equal(agentPolicyAllows(DEFAULT_AGENT_POLICY, { agentId: 'sulla', level: 'metadata' }).allowed, false);
  assert.equal(agentPolicyAllows(policy, { agentId: 'sulla', level: 'autofill', host: 'api.github.com' }).allowed, true);
  assert.equal(agentPolicyAllows(policy, { agentId: 'sulla', level: 'autofill' }).allowed, false);
  assert.equal(agentPolicyAllows(policy, { agentId: 'sulla', level: 'autofill', host: 'github.com/path' }).allowed, false);
  assert.equal(agentPolicyAllows(policy, { agentId: 'sulla', level: 'full' }).allowed, false);
  assert.equal(agentPolicyAllows(policy, { agentId: 'sulla', level: 'autofill', host: 'evilgithub.com' }).allowed, false);
  assert.equal(agentPolicyAllows({ ...policy, expiresAt: '2000-01-01T00:00:00Z' }, { agentId: 'sulla', level: 'metadata' }).allowed, false);
  assert.equal(agentPolicyAllows({ ...policy, expiresAt: 'not-a-date' }, { agentId: 'sulla', level: 'metadata' }).allowed, false);
  assert.equal(agentPolicyAllows(policy, { agentId: 'sulla', level: 'autofill', onServer: true }).allowed, false);
  assert.equal(agentPolicyFromLegacyLlmAccess('').level, 'autofill');
  assert.equal(agentPolicyFromLegacyLlmAccess('none').mode, 'only_me');
});
