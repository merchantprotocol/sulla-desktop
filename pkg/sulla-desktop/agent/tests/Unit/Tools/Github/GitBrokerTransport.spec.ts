// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { withGitHubBrokerRemote } from '../../../../tools/github/gitBrokerTransport';

const { executeStream } = vi.hoisted(() => ({ executeStream: vi.fn() }));
vi.mock('../../../../../vault-broker', () => ({
  requireConfiguredCredentialBroker: () => ({ requestFor: (_ctx: unknown, request: unknown) => request, executeStream }),
}));
vi.mock('../../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({ getActiveAccountId: async() => 'account' }),
}));

describe('GitHub broker HTTP transport', () => {
  it('streams a large slow pack body through the proxy without truncation', async() => {
    // risk: large clone transfer is truncated by buffering or missing backpressure
    const total = 8 * 1024 * 1024;
    const chunk = new Uint8Array(64 * 1024).fill(0x5a);
    executeStream.mockImplementation(async() => new Response(new ReadableStream({
      async start(controller) {
        for (let sent = 0; sent < total; sent += chunk.byteLength) {
          controller.enqueue(chunk);
          await new Promise(resolve => setTimeout(resolve, 2));
        }
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result' } }));

    const received = await withGitHubBrokerRemote({} as any, 'https://github.com/acme/repo.git', async proxyUrl => {
      const parsed = new URL(proxyUrl);
      return await new Promise<number>((resolve, reject) => {
        let bytes = 0;
        http.get({ host: '127.0.0.1', port: Number(parsed.port), path: parsed.pathname + '/git-upload-pack' }, response => {
          response.on('data', data => { bytes += data.byteLength; });
          response.on('end', () => resolve(bytes));
          response.on('error', reject);
        }).on('error', reject);
      });
    });
    expect(received).toBe(total);
  });
});
