// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertVaultAdapter, VAULT_ADAPTER_API_VERSION } from './adapter.js';
test('Vault core accepts only adapter API v1', () => {
  const adapter = { apiVersion: VAULT_ADAPTER_API_VERSION, resolveIdentity: async() => ({}), authenticate: () => (() => {}), register() {} } as never;
  assert.equal(assertVaultAdapter(adapter), adapter);
  assert.throws(() => assertVaultAdapter({ apiVersion: 2, register() {} } as never), /adapter API 1 is required/);
});
