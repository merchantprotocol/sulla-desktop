// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFilesAdapter, FILES_ADAPTER_API_VERSION } from './adapter.js';
test('Files core accepts only adapter API v1', () => {
  const adapter = { apiVersion: FILES_ADAPTER_API_VERSION, authenticate: () => (() => {}), authorizeProvisioning: async() => {}, register() {} } as never;
  assert.equal(assertFilesAdapter(adapter), adapter);
  assert.throws(() => assertFilesAdapter({ apiVersion: 2, register() {} } as never), /adapter API 1 is required/);
});
