// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCOUNTS_ADAPTER_API_VERSION, assertAccountsAdapter } from './adapter.js';

test('Accounts core accepts only adapter API v1', () => {
  const adapter = { apiVersion: ACCOUNTS_ADAPTER_API_VERSION, register() {} };
  assert.equal(assertAccountsAdapter(adapter), adapter);
  assert.throws(() => assertAccountsAdapter({ apiVersion: 2, register() {} } as never), /adapter API 1 is required/);
});
