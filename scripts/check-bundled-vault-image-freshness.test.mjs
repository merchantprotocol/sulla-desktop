// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { BundledVaultImageFreshnessGuard } from './check-bundled-vault-image-freshness.mjs';

const pinSha = 'a'.repeat(40);
const lastInputSha = 'b'.repeat(40);
const manifest = sha => `- { name: sulla-vault, source: ghcr.io/merchantprotocol/sulla-vault:sha-${ sha } }`;

class FakeRepository {
  constructor({ lastInput = lastInputSha, ancestor = true, existing = [pinSha] } = {}) {
    this.lastInput = lastInput;
    this.ancestor = ancestor;
    this.existing = new Set(existing);
    this.lastQueryPaths = null;
  }

  lastCommitTouching(paths) { this.lastQueryPaths = paths; return this.lastInput }
  isAncestor() { return this.ancestor }
  commitExists(sha) { return this.existing.has(sha) }
}

const guardFor = (repository, manifestText = manifest(pinSha)) =>
  new BundledVaultImageFreshnessGuard(repository, () => manifestText);

test('accepts a pin built from a commit that includes the last Vault input change', () => { // risk: release integrity
  const repository = new FakeRepository();
  assert.doesNotThrow(() => guardFor(repository).verify());
  assert.deepEqual(repository.lastQueryPaths, ['services/sulla-vault', 'packages/vault-crypto']);
});

test('rejects a pin older than the last Vault input change', () => { // risk: release integrity
  const repository = new FakeRepository({ ancestor: false });
  assert.throws(() => guardFor(repository).verify(), /older than the last Vault input change/);
});

test('rejects a pin commit that does not exist in the repository', () => { // risk: release integrity
  const repository = new FakeRepository({ existing: [] });
  assert.throws(() => guardFor(repository).verify(), /is not a commit in this repository/);
});

test('rejects a mutable Vault image tag', () => { // risk: release integrity
  const guard = guardFor(new FakeRepository(), '- { name: sulla-vault, source: ghcr.io/merchantprotocol/sulla-vault:latest }');
  assert.throws(() => guard.verify(), /immutable sha/);
});
