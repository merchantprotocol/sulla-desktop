// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { BundledVaultParityGuard } from './check-bundled-vault-parity.mjs';

const currentSha = '7'.repeat(40);
const oldSha = 'e'.repeat(40);
const manifest = sha => `- { name: sulla-vault, source: ghcr.io/merchantprotocol/sulla-vault:sha-${ sha } }`;
const clientSource = `
  request('/v1/broker/sulla-cloud/enrollment-wrap');
  request('/v1/broker/sulla-cloud/enrollment-adopt');
  request('/v1/broker/sulla-cloud/enrollment-commit');
`;
const compatibleServerSource = `
  route('/v1/broker/sulla-cloud/enrollment-wrap');
  route('/v1/broker/sulla-cloud/enrollment-adopt');
  route('/v1/broker/sulla-cloud/enrollment-commit');
`;

class FakeRepository {
  constructor({ ancestor = true, serverByCommit = { HEAD: compatibleServerSource } } = {}) {
    this.ancestor = ancestor;
    this.serverByCommit = serverByCommit;
  }

  isAncestor() { return this.ancestor }
  source(path, commit = 'HEAD') {
    if (path === BundledVaultParityGuard.clientPath) return clientSource;
    return this.serverByCommit[commit] ?? '';
  }
}

class BundledVaultGuardFixture {
  constructor(repository, sha = currentSha) {
    this.guard = new BundledVaultParityGuard(repository, () => manifest(sha));
  }

  verify() { this.guard.verify() }
}

test('accepts next-release Vault source implementing every Desktop enrollment route', () => { // risk: account access
  assert.doesNotThrow(() => new BundledVaultGuardFixture(new FakeRepository()).verify());
});

test('rejects next-release Vault source missing Desktop enrollment routes', () => { // risk: existing encrypted data access
  const repository = new FakeRepository({ serverByCommit: { HEAD: '' } });
  assert.throws(
    () => new BundledVaultGuardFixture(repository, oldSha).verify(),
    /enrollment-adopt.*enrollment-commit.*enrollment-wrap/,
  );
});

test('rejects a mutable Vault image tag', () => { // risk: release integrity
  const guard = new BundledVaultParityGuard(new FakeRepository(), () => '- { name: sulla-vault, source: ghcr.io/merchantprotocol/sulla-vault:latest }');
  assert.throws(() => guard.verify(), /immutable sha/);
});
