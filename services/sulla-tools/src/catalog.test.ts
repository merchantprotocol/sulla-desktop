import assert from 'node:assert/strict';
import test from 'node:test';

import { credentialIntegrationForTool } from './catalog.js';

import type { CatalogTool } from './catalog.js';

function tool(name: string, category: string): CatalogTool {
  return { name, category, description: '', schemaDef: {}, executionTarget: 'catalog' };
}

test('mobile credential scopes are issued only for mobile-capable catalog calls', () => {
  assert.equal(credentialIntegrationForTool(tool('mobile_list_calls', 'mobile'), {}), 'sulla-cloud');
  assert.equal(credentialIntegrationForTool(tool('notify_user', 'notify'), { targets: ['desktop', 'mobile'] }), 'sulla-cloud');
  assert.equal(credentialIntegrationForTool(tool('notify_user', 'notify'), { targets: ['desktop'] }), undefined);
  assert.equal(credentialIntegrationForTool(tool('notify_history', 'notify'), { targets: ['mobile'] }), undefined);
});
