// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { BundledFilesParityGuard } from './check-bundled-files-parity.mjs';

const sha = '7'.repeat(40);
const manifest = `- { name: sulla-files, source: ghcr.io/merchantprotocol/sulla-files:sha-${ sha } }`;

class FakeRepository {
  constructor({ ancestor = true, bundled = ['001_base.sql'], current = ['001_base.sql'] } = {}) {
    this.ancestor = ancestor;
    this.bundled = bundled;
    this.current = current;
  }

  isAncestor() { return this.ancestor }
  migrationNames(commit = 'HEAD') { return new Set(commit === 'HEAD' ? this.current : this.bundled) }
}

class BundledFilesGuardFixture {
  constructor(repository) {
    this.guard = new BundledFilesParityGuard(repository, () => manifest);
  }

  verify() { this.guard.verify() }
}

test('accepts an ancestor Files image containing every migration', () => { // risk: release integrity
  assert.doesNotThrow(() => new BundledFilesGuardFixture(new FakeRepository()).verify());
});

test('rejects a bundled Files image missing a lifecycle migration', () => { // risk: approval bypass
  const repository = new FakeRepository({ current: ['001_base.sql', '059_agent_identity_versions_are_drafts.sql'] });
  assert.throws(() => new BundledFilesGuardFixture(repository).verify(), /059_agent_identity_versions_are_drafts/);
});

test('rejects a Files image from an unrelated commit', () => { // risk: release integrity
  assert.throws(() => new BundledFilesGuardFixture(new FakeRepository({ ancestor: false })).verify(), /not an ancestor/);
});
