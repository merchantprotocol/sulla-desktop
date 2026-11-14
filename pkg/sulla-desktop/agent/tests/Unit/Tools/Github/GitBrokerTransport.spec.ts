// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { withGitHubBrokerRemote } from '../../../../tools/github/gitBrokerTransport';

const { executeStream, info } = vi.hoisted(() => ({ executeStream: vi.fn(), info: vi.fn() }));
vi.mock('@pkg/utils/logging', () => ({ default: { background: { info } } }));
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

  it('logs token-free request identity, byte count, duration, and termination side', async() => {
    info.mockClear();
    let token = '';
    executeStream.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const received = await withGitHubBrokerRemote({} as any, 'https://github.com/acme/repo.git', async proxyUrl => {
      const parsed = new URL(proxyUrl);
      token = parsed.pathname.split('/')[1];
      return await new Promise<number>((resolve, reject) => {
        let bytes = 0;
        http.get({ host: '127.0.0.1', port: Number(parsed.port), path: `${ parsed.pathname }/git-upload-pack` }, response => {
          response.on('data', chunk => { bytes += chunk.byteLength; });
          response.on('end', () => resolve(bytes));
          response.on('error', reject);
        }).on('error', reject);
      });
    });
    expect(received).toBe(3);
    const record = JSON.parse(String(info.mock.calls.at(-1)?.[0]));
    expect(record).toMatchObject({ component: 'github.git.broker', repository: 'acme/repo', service: 'upload-pack', bytesForwarded: 3, endedBy: 'upstream-end' });
    expect(record.requestId).toEqual(expect.any(String));
    expect(record.durationMs).toEqual(expect.any(Number));
    expect(record.startedAt).toEqual(expect.any(String));
    expect(String(info.mock.calls.at(-1)?.[0])).not.toContain(token);
  });
});
