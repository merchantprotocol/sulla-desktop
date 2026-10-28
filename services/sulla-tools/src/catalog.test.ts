// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import { credentialIntegrationForTool } from './catalog.js';

import type { CatalogTool } from './catalog.js';

function tool(name: string, category: string): CatalogTool {
  return { name, category, description: '', schemaDef: {}, executionTarget: 'catalog' };
}

test('mobile credential scopes are issued only for mobile-capable catalog calls', () => {
  assert.equal(credentialIntegrationForTool(tool('notify_user', 'notify'), { targets: ['desktop', 'mobile'] }), 'sulla-cloud');
  assert.equal(credentialIntegrationForTool(tool('notify_user', 'notify'), { targets: ['desktop'] }), undefined);
  assert.equal(credentialIntegrationForTool(tool('notify_history', 'notify'), { targets: ['mobile'] }), undefined);
});
