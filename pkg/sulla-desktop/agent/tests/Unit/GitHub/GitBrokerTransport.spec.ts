// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import http from 'node:http';

import { Response as UndiciResponse } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeStream: vi.fn(),
  getActiveAccountId: vi.fn(),
  requestFor: vi.fn(),
  requireConfiguredCredentialBroker: vi.fn(),
}));

vi.mock('../../../../vault-broker', () => ({
  configuredVaultBrokerProvider: {
    requireConfiguredCredentialBroker: mocks.requireConfiguredCredentialBroker,
  },
}));

vi.mock('../../../../agent/services/IntegrationService', () => ({
  getIntegrationService: () => ({ getActiveAccountId: mocks.getActiveAccountId }),
}));

vi.mock('@pkg/utils/logging', () => ({
  default: { background: { debug: vi.fn(), info: vi.fn() } },
}));

import { withGitHubBrokerRemote } from '../../../tools/github/gitBrokerTransport';

describe('withGitHubBrokerRemote response headers', () => {
  afterEach(() => vi.clearAllMocks());

  it('keeps decoded GitHub advertisement bytes and content type without forwarding stale encoding', async() => {
    // risk: data accuracy — dropping the smart-HTTP media type makes Git fall back to dumb HTTP; retaining a stale gzip label corrupts already-decoded bytes.
    const advertisement = Buffer.from([0x30, 0x30, 0x30, 0x38, 0x00, 0x47, 0xff, 0x00]);
    const upstream = new UndiciResponse(advertisement, {
      status:  200,
      headers: {
        'content-type':     'application/x-git-upload-pack-advertisement',
        'content-encoding': 'gzip',
      },
    });
    mocks.getActiveAccountId.mockResolvedValue('test-account');
    mocks.requestFor.mockReturnValue({});
    mocks.executeStream.mockResolvedValue(upstream);
    mocks.requireConfiguredCredentialBroker.mockReturnValue({
      requestFor:    mocks.requestFor,
      executeStream: mocks.executeStream,
    });

    const result = await withGitHubBrokerRemote({} as never, 'https://github.com/merchantprotocol/sulla-desktop.git', async(proxyUrl) => {
      const target = new URL(proxyUrl);
      target.hostname = '127.0.0.1';
      target.pathname += '/info/refs';
      target.searchParams.set('service', 'git-upload-pack');
      return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
        const request = http.get(target, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('end', () => resolve({
            status:  response.statusCode ?? 0,
            headers: response.headers,
            body:    Buffer.concat(chunks),
          }));
        });
        request.once('error', reject);
      });
    });

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/x-git-upload-pack-advertisement');
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.body).toEqual(advertisement);
  });
});
