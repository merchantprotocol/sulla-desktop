// SPDX-License-Identifier: GPL-2.0-or-later
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { CloudVaultSyncHttpTransport, VaultSyncHttpError, type VaultSyncHttpClient } from '@pkg/main/cloud/vaultSyncV3/transport';

class LocalHttpClient implements VaultSyncHttpClient {
  request(url: string, init?: RequestInit): Promise<Response> { return fetch(url, init); }
}

describe('CloudVaultSyncHttpTransport', () => {
  it('preserves method, path, JSON body, and auth headers against a real HTTP server', async () => {
    const requests: { method?: string; url?: string; auth?: string | null; body: string }[] = [];
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('server did not bind');
      const transport = new CloudVaultSyncHttpTransport({ client: new LocalHttpClient(), baseUrl: `http://127.0.0.1:${address.port}`, authHeaders: async () => ({ authorization: 'Bearer synthetic' }) });
      await transport.commit('vault/1', { handle: 'h', head: 4 }, { deviceId: 'device/1', timestamp: 7, signature: 'sig' });
      expect(requests[0]).toMatchObject({ method: 'POST', url: '/cloud-vault-sync/vaults/vault%2F1/commit?deviceId=device%2F1', auth: 'Bearer synthetic', body: JSON.stringify({ handle: 'h', head: 4 }) });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('maps conflict and locked responses without leaking response material', async () => {
    const server = createServer((_req, res) => { res.statusCode = 423; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 'vault_locked', secret: 'do-not-leak' })); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('server did not bind');
      const transport = new CloudVaultSyncHttpTransport({ client: new LocalHttpClient(), baseUrl: `http://127.0.0.1:${address.port}`, authHeaders: {} });
      await expect(transport.getStatus('v')).rejects.toMatchObject({ code: 'vault_locked', status: 423 });
      try { await transport.getStatus('v'); } catch (error) { expect(error).toBeInstanceOf(VaultSyncHttpError); expect(String(error)).not.toContain('do-not-leak'); }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('rejects non-JSON success and oversized responses', async () => {
    let oversized = false;
    const server = createServer((_req, res) => { res.setHeader('content-type', 'text/plain'); res.end(oversized ? 'x'.repeat(100) : 'not-json'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('server did not bind');
      const transport = new CloudVaultSyncHttpTransport({ client: new LocalHttpClient(), baseUrl: `http://127.0.0.1:${address.port}`, authHeaders: {}, maxResponseBytes: 16 });
      await expect(transport.getStatus('v')).rejects.toMatchObject({ code: 'invalid_body' });
      oversized = true; await expect(transport.getStatus('v')).rejects.toMatchObject({ code: 'too_large' });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
