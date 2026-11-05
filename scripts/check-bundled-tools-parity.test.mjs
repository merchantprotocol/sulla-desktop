// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';
import { BundledToolsParityGuard } from './check-bundled-tools-parity.mjs';

const sha = '7'.repeat(40);
const manifest = `- { name: sulla-tools, source: ghcr.io/merchantprotocol/sulla-tools:sha-${ sha } }`;

class FakeRepository {
  constructor({ ancestor = true, distance = 1, bundled = ['wait'], current = ['wait'] } = {}) {
    this.ancestor = ancestor; this.distance = distance; this.bundled = bundled; this.current = current;
  }
  isAncestor() { return this.ancestor }
  commitDistance() { return this.distance }
  manifestNames(commit = 'HEAD') { return new Set(commit === 'HEAD' ? this.current : this.bundled) }
}

function guard(repository) {
  return new BundledToolsParityGuard(repository, () => manifest);
}

test('accepts a recent ancestor image containing every registered tool', () => { // risk: release integrity
  assert.doesNotThrow(() => guard(new FakeRepository()).verify());
});

test('rejects a bundled catalog missing a delegated tool', () => { // risk: worker control loss
  assert.throws(() => guard(new FakeRepository({ bundled: [] })).verify(), /wait/);
});

test('rejects stale and non-ancestor image commits', () => { // risk: stale release artifact
  assert.throws(() => guard(new FakeRepository({ distance: 51 })).verify(), /51 commits behind/);
  assert.throws(() => guard(new FakeRepository({ ancestor: false })).verify(), /not an ancestor/);
});
