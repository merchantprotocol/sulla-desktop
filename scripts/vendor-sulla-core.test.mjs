// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { VendoredTarballName } from './vendor-sulla-core.mjs';

// risk: data accuracy - vendored tarball names must track the real package version
test('tarball name carries the package version, not a hardcoded one', () => {
  assert.equal(VendoredTarballName.for('foundation', '0.1.1', '7d4a6dd'), 'sulla-foundation-0.1.1-7d4a6dd.tgz');
  assert.equal(VendoredTarballName.for('domain', '0.3.3', 'ea82b05'), 'sulla-domain-0.3.3-ea82b05.tgz');
});

test('rejects a missing or malformed version instead of producing a bad filename', () => {
  assert.throws(() => VendoredTarballName.for('domain', undefined, 'ea82b05'));
  assert.throws(() => VendoredTarballName.for('domain', '../0.3.3', 'ea82b05'));
});
