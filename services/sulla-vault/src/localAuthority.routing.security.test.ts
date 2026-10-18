import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { localAuthorityTestHooks } from './localAuthority.js';

function syntheticItem(integrationId: string): any {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${ encode({ alg: 'none' }) }.${ encode({
    'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-synthetic' },
  }) }.signature`;

  return {
    integration: {
      integrationId,
      accountId: 'synthetic',
      properties: { access_token: accessToken },
    },
  };
}

describe('local authority ChatGPT routing', () => {
  test('derives account routing only in memory for the Codex final hop', () => {
    const codex = syntheticItem('codex');
    localAuthorityTestHooks.deriveChatgptAccountRoutingForRequest({
      operation: 'provider.cli', ref: { integrationId: 'codex', accountId: 'synthetic' },
    }, codex);
    assert.deepEqual(codex.integration.properties, {
      access_token: codex.integration.properties.access_token,
      chatgpt_account_id: 'workspace-synthetic',
    });
    assert.equal(typeof codex.integration.properties.access_token, 'string');

    for (const request of [
      { operation: 'provider.cli', ref: { integrationId: 'openai', accountId: 'synthetic' } },
      { operation: 'oauth.token', ref: { integrationId: 'codex', accountId: 'synthetic' } },
    ]) {
      const other = syntheticItem(request.ref.integrationId);
      localAuthorityTestHooks.deriveChatgptAccountRoutingForRequest(request, other);
      assert.equal(other.integration.properties.chatgpt_account_id, undefined);
    }
  });
});
