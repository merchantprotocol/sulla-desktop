// SPDX-License-Identifier: GPL-2.0-or-later
import { createServer, request as httpRequest, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { CloudVaultSyncHttpTransport, VaultSyncHttpError, type VaultSyncHttpClient } from '@pkg/main/cloud/vaultSyncV3/transport';

class NodeHttpClient implements VaultSyncHttpClient {
  request(url: string, init?: RequestInit): Promise<Response> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(url, { method: init?.method, headers: init?.headers as Record<string, string> | undefined }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        })));
        response.on('error', reject);
      });
      request.on('error', reject);
      if (typeof init?.body === 'string') request.write(init.body);
      request.end();
    });
  }
}

class LocalVaultResponseServer {
  private readonly server: Server;

  constructor(private readonly recordsBody: string, private readonly statusBody: string) {
    this.server = createServer((request, response) => {
      const body = request.url?.includes('/records') ? this.recordsBody : this.statusBody;
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Local HTTP server did not expose a port');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}

class FakeHttpClient implements VaultSyncHttpClient {
  readonly requests: { url: string; init?: RequestInit }[] = [];
  constructor(private readonly responseFactory: (url: string, init?: RequestInit) => Response) {}
  request(url: string, init?: RequestInit): Promise<Response> {
    this.requests.push({ url, init });
    return Promise.resolve(this.responseFactory(url, init));
  }
}

describe('CloudVaultSyncHttpTransport', () => {
  it('preserves method, path, JSON body, and auth headers through the injected HTTP client', async () => {
    const client = new FakeHttpClient(() => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const transport = new CloudVaultSyncHttpTransport({ client, baseUrl: 'https://cloud.test', authHeaders: async () => ({ authorization: 'Bearer synthetic' }) });
    await transport.commit('vault/1', { handle: 'h', head: 4 }, { deviceId: 'device/1', timestamp: 7, signature: 'sig' });
    expect(client.requests[0]).toMatchObject({ url: 'https://cloud.test/cloud-vault-sync/vaults/vault%2F1/commit?deviceId=device%2F1', init: { method: 'POST', headers: { authorization: 'Bearer synthetic', 'X-Sulla-Timestamp': '7', 'X-Sulla-Device-Signature': 'sig', 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'h', head: 4 }) } });
  });

  it('maps conflict and locked responses without leaking response material', async () => {
    const client = new FakeHttpClient(() => new Response(JSON.stringify({ code: 'vault_locked', secret: 'do-not-leak' }), { status: 423, headers: { 'content-type': 'application/json' } }));
    const transport = new CloudVaultSyncHttpTransport({ client, authHeaders: async () => ({}) });
    await expect(transport.getStatus('v')).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
    try { await transport.getStatus('v'); } catch (error) { expect(error).toBeInstanceOf(VaultSyncHttpError); expect(String(error)).not.toContain('do-not-leak'); }
  });

  it('rejects non-JSON success and oversized responses', async () => {
    let oversized = false;
    const client = new FakeHttpClient(() => new Response(oversized ? 'x'.repeat(100) : 'not-json', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const transport = new CloudVaultSyncHttpTransport({ client, authHeaders: async () => ({}), maxResponseBytes: 16 });
    await expect(transport.getStatus('v')).rejects.toMatchObject({ code: 'invalid_body' });
    oversized = true; await expect(transport.getStatus('v')).rejects.toMatchObject({ code: 'too_large' });
  });
});


describe('CloudVaultSyncHttpTransport response limits', () => {
  it('accepts a large records page while rejecting an oversized status response', async () => {
    // risk: data availability — normal vault pages may exceed the small control-response cap.
    const records = Array.from({ length: 20 }, (_, index) => ({ id: index, payload: 'x'.repeat(64 * 1024) }));
    const server = new LocalVaultResponseServer(JSON.stringify({ records }), JSON.stringify({ status: 'x'.repeat(1024 * 1024) }));
    const baseUrl = await server.start();
    try {
      const transport = new CloudVaultSyncHttpTransport({ client: new NodeHttpClient(), baseUrl, authHeaders: async () => ({}) });
      await expect(transport.getRecords('vault-1', 'device-1')).resolves.toMatchObject({ records });
      await expect(transport.getStatus('device-1')).rejects.toMatchObject({ code: 'too_large', status: 413 });
    } finally {
      await server.close();
    }
  });
});
