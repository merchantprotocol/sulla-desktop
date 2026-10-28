// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENTS_ADAPTER_API_VERSION, assertAgentsAdapter } from './adapter.js';
test('Agents adapter API v1 rejects incompatible adapters', () => {
  assert.doesNotThrow(() => assertAgentsAdapter({ apiVersion: AGENTS_ADAPTER_API_VERSION, register() {} }));
  assert.throws(() => assertAgentsAdapter({ apiVersion: 2, register() {} } as never), /API 1/);
});
