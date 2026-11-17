// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

// The Tools container ships pkg/sulla-desktop/{agent,runtime,vault-broker,utils} only.
// These tools must reach Files through the container client, never through main/.
vi.mock('../../../tools/files/common', () => ({
  FilesTool: class {
    state = { metadata: {} };
    context() { return {} }
    async resolvePath() { return undefined }
    async containerJson() { return undefined }
    async containerRequest() { throw new Error('containerRequest must be overridden in tests') }
  },
}));

import { FilesLinkWorker } from '../../../tools/files/link';
import { FilesRevokeLinkWorker } from '../../../tools/files/revoke_link';

type Captured = { path: string; init: RequestInit };

class RecordingLinkWorker extends FilesLinkWorker {
  calls: Captured[] = [];
  constructor(private readonly status: number = 201, private readonly body: unknown = { public_url: 'https://sulla.example/s/abc' }) { super() }
  protected override async containerJson<T = any>(path: string, _input: unknown): Promise<T> {
    if (path === '/v1/agent-files/file-1') return { file: { collection_id: 'collection-1' } } as T;
    throw new Error(`Unexpected API call ${ path }`);
  }
  protected override async containerRequest(path: string, _input: unknown, init: RequestInit = {}): Promise<Response> {
    this.calls.push({ path, init });
    // Mirrors filesContainerRequest: a non-2xx response throws with Files' error message.
    if (this.status >= 400) {
      const error = (this.body as { error?: unknown })?.error;
      throw new Error(typeof error === 'string' && error ? error : `Sulla Files returned ${ this.status }`);
    }
    return new Response(JSON.stringify(this.body), { status: this.status, headers: { 'content-type': 'application/json' } });
  }
  execute(input: any) { return this._validatedCall(input) }
}

class RecordingRevokeWorker extends FilesRevokeLinkWorker {
  calls: Captured[] = [];
  constructor(private readonly failure?: Error) { super() }
  protected override async containerRequest(path: string, _input: unknown, init: RequestInit = {}): Promise<Response> {
    this.calls.push({ path, init });
    if (this.failure) throw this.failure;
    return new Response(null, { status: 204 });
  }
  execute(input: any) { return this._validatedCall(input) }
}

describe('FilesLinkWorker (container call path, no main/ import)', () => {
  it('creates the share through Files with owner-scoped fields and the requested expiry', async() => {
    // risk: tenant isolation / access control — the link must be created for the requested file, with its expiry, via the Files owner path.
    const worker = new RecordingLinkWorker();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const response = await worker.execute({ file_id: 'file-1', access_mode: 'view', expires_at: expiresAt });

    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0].path).toBe('/v1/links');
    expect(worker.calls[0].init.method).toBe('POST');
    const sent = JSON.parse(String(worker.calls[0].init.body));
    expect(sent).toMatchObject({ fileId: 'file-1', collectionId: 'collection-1', permission: 'view', assetKind: 'file', keepAvailable: false, expiresAt });
    expect(sent).not.toHaveProperty('deviceId');
    expect(response.successBoolean).toBe(true);
    expect(response.responseString).toBe('Share link created: https://sulla.example/s/abc');
  });

  it('rejects a past expiry without contacting Files', async() => {
    // risk: expiry — a link must never be created already expired or with an invalid timestamp.
    const worker = new RecordingLinkWorker();
    const response = await worker.execute({ file_id: 'file-1', expires_at: new Date(Date.now() - 60_000).toISOString() });

    expect(worker.calls).toHaveLength(0);
    expect(response).toEqual({ successBoolean: false, responseString: 'expires_at must be a future ISO timestamp.' });
  });

  it('reports Files refusals (for example signed out or not owner) instead of faking success', async() => {
    // risk: permissions — Files is the authority for sign-in and ownership; a refusal must surface as a failed share.
    const worker = new RecordingLinkWorker(401, { error: 'Sign in to Sulla Cloud before sharing' });
    const response = await worker.execute({ file_id: 'file-1' });

    expect(response.successBoolean).toBe(false);
    expect(response.responseString).toBe('Share link registration failed: Sign in to Sulla Cloud before sharing');
  });
});

describe('FilesRevokeLinkWorker (container call path, no main/ import)', () => {
  it('revokes the link through the owner-scoped Files endpoint', async() => {
    // risk: revocation — revoke must hit the exact link id, encoded, through Files.
    const worker = new RecordingRevokeWorker();
    const response = await worker.execute({ id: 'link/with spaces' });

    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0].path).toBe('/v1/links/link%2Fwith%20spaces');
    expect(worker.calls[0].init.method).toBe('DELETE');
    expect(response).toEqual({ successBoolean: true, responseString: 'Share link revoked.' });
  });

  it('refuses a missing id without contacting Files', async() => {
    // risk: revocation — an empty id must never turn into a request against the collection route.
    const worker = new RecordingRevokeWorker();
    const response = await worker.execute({});

    expect(worker.calls).toHaveLength(0);
    expect(response.successBoolean).toBe(false);
  });

  it('returns the Files error when revocation is refused', async() => {
    // risk: revocation — a refused revoke must not be reported as revoked.
    const worker = new RecordingRevokeWorker(new Error('Local access is disabled; remote deletion could not be confirmed and is queued for retry'));
    const response = await worker.execute({ id: 'link-1' });

    expect(response.successBoolean).toBe(false);
    expect(response.responseString).toContain('queued for retry');
  });
});

describe('container-shipped share tools import boundary', () => {
  it('has no static or dynamic @pkg/main import in link or revoke_link', async() => {
    // risk: deploy boundary — a @pkg/main import (static or dynamic) breaks the Tools container at call time, not at build time.
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../tools/files');
    for (const name of ['link.ts', 'revoke_link.ts']) {
      const source = readFileSync(join(dir, name), 'utf8');
      expect(source, name).not.toMatch(/@pkg\/main/);
    }
  });
});
