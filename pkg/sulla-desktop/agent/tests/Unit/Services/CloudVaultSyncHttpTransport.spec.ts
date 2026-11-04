// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';
import { CloudVaultSyncHttpTransport, VaultSyncHttpError, type VaultSyncHttpClient } from '@pkg/main/cloud/vaultSyncV3/transport';

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
