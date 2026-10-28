// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

describe('local authority BYO usage route', () => {
  test('allows only POST to the exact usage ingestion path', () => {
    expect(localAuthorityTestHooks.allowsByoUsageCloudRequest('POST', '/usage/byo-events')).toBe(true);
    expect(localAuthorityTestHooks.allowsByoUsageCloudRequest('GET', '/usage/byo-events')).toBe(false);
    expect(localAuthorityTestHooks.allowsByoUsageCloudRequest('POST', '/usage/byo-events/extra')).toBe(false);
  });
});

describe('local authority Sulla Cloud Desktop routes', () => {
  test('allows only the exact Files catalog and content relay methods', () => {
    const allowed: Array<[string, string]> = [
      ['PUT', '/cloud-files/v1/catalog/11a08604-example'],
      ['GET', '/cloud-files/v1/catalog/11a08604-example/desktop-requests'],
      ['PUT', '/cloud-files/v1/catalog/11a08604-example/desktop-requests/request-1/content'],
      ['POST', '/cloud-files/v1/catalog/11a08604-example/desktop-requests/request-1/link'],
      ['POST', '/cloud-files/v1/catalog/11a08604-example/desktop-requests/request-1/fail'],
      ['POST', '/shares'],
      ['PATCH', '/shares/share-1'],
      ['DELETE', '/shares/share-1'],
      ['PUT', '/shares/share-1/content'],
    ];
    for (const [method, path] of allowed) {
      expect(localAuthorityTestHooks.allowsSullaCloudDesktopRequest(method, path)).toBe(true);
    }
    for (const [method, path] of [
      ['GET', '/cloud-files/v1/catalog/11a08604-example'],
      ['POST', '/cloud-files/v1/catalog/11a08604-example/desktop-requests/request-1/content'],
      ['GET', '/cloud-files/v1/files'],
      ['GET', '/shares/share-1/content'],
      ['PUT', '/cloud-files/v1/catalog/../../devices/register'],
    ]) {
      expect(localAuthorityTestHooks.allowsSullaCloudDesktopRequest(method, path)).toBe(false);
    }
  });
});
