import { describe, expect, test } from '@jest/globals';

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
    expect(codex.integration.properties).toEqual({
      access_token: expect.any(String),
      chatgpt_account_id: 'workspace-synthetic',
    });

    for (const request of [
      { operation: 'provider.cli', ref: { integrationId: 'openai', accountId: 'synthetic' } },
      { operation: 'oauth.token', ref: { integrationId: 'codex', accountId: 'synthetic' } },
    ]) {
      const other = syntheticItem(request.ref.integrationId);
      localAuthorityTestHooks.deriveChatgptAccountRoutingForRequest(request, other);
      expect(other.integration.properties.chatgpt_account_id).toBeUndefined();
    }
  });
});
