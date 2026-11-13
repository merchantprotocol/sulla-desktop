// SPDX-License-Identifier: GPL-2.0-or-later
import { createServer, request as httpRequest, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { CloudVaultSyncHttpTransport, VaultSyncHttpError, type VaultSyncHttpClient } from '@pkg/main/cloud/vaultSyncV3/transport';
import { CloudEnrollmentTransport, FixedEnrollmentUser } from '@pkg/main/cloud/enrollment/CloudEnrollmentTransport';
import type { VaultSyncRequestSigner } from '@pkg/main/cloud/enrollment/VaultSyncRequestSigner';

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

/** A real local Cloud stand-in for the enrollment deny route: records each request and answers with a scripted status. */
class RecordingDenyServer {
  readonly requests: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] = [];
  private readonly server: Server;
  reply: { status: number; body: unknown } = { status: 200, body: { ok: true, denied: true } };

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        this.requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        const body = JSON.stringify(this.reply.body);
        response.writeHead(this.reply.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        response.end(body);
      });
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

/** Signs with a fixed synthetic signature; the real device signature is pinned in the enrollment characterization specs. */
class FixedSigner {
  readonly signed: { userId: string; vaultId: string; operation: string; body?: Uint8Array }[] = [];
  async deviceId(): Promise<string> { return 'device-1' }
  async sign(userId: string, vaultId: string, operation: string, body?: Uint8Array) {
    this.signed.push({ userId, vaultId, operation, body });
    return { deviceId: 'device-1', timestamp: 1770000000, signature: 'synthetic-signature' };
  }
}

describe('CloudEnrollmentTransport deny over HTTP', () => {
  const VAULT = '11111111-2222-4333-8444-555555555555';

  async function withServer(run: (server: RecordingDenyServer, transport: CloudEnrollmentTransport, signer: FixedSigner) => Promise<void>) {
    const server = new RecordingDenyServer();
    const baseUrl = await server.start();
    const signer = new FixedSigner();
    const http = new CloudVaultSyncHttpTransport({ client: new NodeHttpClient(), baseUrl, authHeaders: async () => ({ authorization: 'Bearer synthetic' }) });
    try {
      await run(server, new CloudEnrollmentTransport(http, signer as unknown as VaultSyncRequestSigner, new FixedEnrollmentUser('user-1')), signer);
    } finally {
      await server.close();
    }
  }

  it('sends one signed POST to the deny route with the exact body bytes it signed', async () => {
    // risk: auth — Cloud verifies sha256 over the received body against the device signature for enrollment-deny:<id>
    await withServer(async (server, transport, signer) => {
      await transport.denyEnrollmentRequest(VAULT, 'req-a', { reason: 'user_denied' });
      expect(server.requests).toHaveLength(1);
      const [sent] = server.requests;
      expect(sent.method).toBe('POST');
      expect(sent.url).toBe(`/cloud-vault-sync/vaults/${VAULT}/enrollment/requests/req-a/deny?deviceId=device-1`);
      expect(sent.body).toBe(JSON.stringify({ reason: 'user_denied' }));
      expect(sent.headers).toMatchObject({ authorization: 'Bearer synthetic', 'x-sulla-timestamp': '1770000000', 'x-sulla-device-signature': 'synthetic-signature' });
      expect(signer.signed).toHaveLength(1);
      expect(signer.signed[0]).toMatchObject({ userId: 'user-1', vaultId: VAULT, operation: 'enrollment-deny:req-a' });
      expect(Buffer.from(signer.signed[0].body!).toString('utf8')).toBe(sent.body);
    });
  });

  it('treats 404 (Cloud without the deny route) as not supported and resolves', async () => {
    // risk: availability — Desktop shipping before the Cloud deploy must not surface an error
    await withServer(async (server, transport) => {
      server.reply = { status: 404, body: { error: 'not_found' } };
      await expect(transport.denyEnrollmentRequest(VAULT, 'req-a', { reason: 'user_denied' })).resolves.toBeUndefined();
      expect(server.requests).toHaveLength(1);
    });
  });

  it('rejects on other failures (409 already answered, 500) so the caller can log them', async () => {
    // risk: data integrity — a deny that did not land must not look like it did
    await withServer(async (server, transport) => {
      server.reply = { status: 409, body: { error: 'request_not_pending' } };
      await expect(transport.denyEnrollmentRequest(VAULT, 'req-a', {})).rejects.toMatchObject({ status: 409 });
      expect(server.requests[0].body).toBe('{}');
      server.reply = { status: 500, body: { error: 'internal_error' } };
      await expect(transport.denyEnrollmentRequest(VAULT, 'req-a', {})).rejects.toMatchObject({ status: 500 });
    });
  });
});
