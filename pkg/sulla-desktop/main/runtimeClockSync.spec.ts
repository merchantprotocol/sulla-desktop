// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { RuntimeClockSyncAuthenticator } from '../../../packages/runtime-protocol/src/runtimeClockSync.js';
import { HostRuntimeClockSyncEndpoint } from './runtimeClockSync.js';

const installationSecret = Buffer.alloc(48, 9).toString('base64url');

describe('host-authoritative runtime clock sync', () => {
  it('requires an authenticated private request and rejects replayed nonces', async() => {
    // risk: authorization integrity — only the trusted guest can request resync, and signed requests are one-use.
    let syncCalls = 0;
    const endpoint = new HostRuntimeClockSyncEndpoint(() => installationSecret, async() => { syncCalls++; });
    const authenticator = new RuntimeClockSyncAuthenticator(installationSecret);
    const nonce = Buffer.alloc(16, 4).toString('base64url');
    const request = { remoteAddress: '127.0.0.1', nonce, signature: authenticator.sign(nonce) };

    await expect(endpoint.handle(request)).resolves.toEqual({ status: 200 });
    await expect(endpoint.handle(request)).resolves.toEqual({ status: 409, error: 'replayed' });
    expect(syncCalls).toBe(1);
  });

  it('rejects forged signatures and non-private request sources without changing the VM clock', async() => {
    // risk: authorization integrity — a LAN caller cannot set the guest clock with a forged request.
    let syncCalls = 0;
    const endpoint = new HostRuntimeClockSyncEndpoint(() => installationSecret, async() => { syncCalls++; });
    const authenticator = new RuntimeClockSyncAuthenticator(installationSecret);
    const forgedNonce = Buffer.alloc(16, 5).toString('base64url');
    const remoteNonce = Buffer.alloc(16, 6).toString('base64url');

    await expect(endpoint.handle({ remoteAddress: '127.0.0.1', nonce: forgedNonce, signature: 'A'.repeat(43) }))
      .resolves.toEqual({ status: 403, error: 'forbidden' });
    await expect(endpoint.handle({ remoteAddress: '203.0.113.9', nonce: remoteNonce, signature: authenticator.sign(remoteNonce) }))
      .resolves.toEqual({ status: 403, error: 'forbidden' });
    expect(syncCalls).toBe(0);
  });

  it('reports synchronization failure instead of claiming the guest clock was corrected', async() => {
    // risk: authentication integrity — callers must retry verification only after host correction succeeds.
    const endpoint = new HostRuntimeClockSyncEndpoint(() => installationSecret, async() => { throw new Error('runtime unavailable'); });
    const authenticator = new RuntimeClockSyncAuthenticator(installationSecret);
    const nonce = Buffer.alloc(16, 8).toString('base64url');

    await expect(endpoint.handle({ remoteAddress: '127.0.0.1', nonce, signature: authenticator.sign(nonce) }))
      .resolves.toEqual({ status: 503, error: 'unavailable' });
  });
});
