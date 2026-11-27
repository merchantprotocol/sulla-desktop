// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { RuntimeClockSyncAuthenticator } from '../../../packages/runtime-protocol/src/runtimeClockSync.js';
import { HostClockSyncClient } from './HostClockSyncClient.js';

const installationSecret = Buffer.alloc(48, 11).toString('base64url');
const endpoint = 'http://host.sulla.internal:3000/internal/runtime/sync-clock';
const nonce = Buffer.alloc(16, 7).toString('base64url');

describe('host clock sync client', () => {
  it('sends an authenticated request without trusting a guest-supplied time', async() => {
    // risk: clock integrity — the host, not the guest, remains authoritative for the time value.
    let requestCount = 0;
    const client = new HostClockSyncClient(endpoint, installationSecret, async(input, init) => {
      requestCount++;
      const headers = new Headers(init?.headers);
      const authenticator = new RuntimeClockSyncAuthenticator(installationSecret);
      expect(String(input)).toBe(endpoint);
      expect(headers.get('authorization')).toBe(`Bearer ${ installationSecret }`);
      expect(authenticator.verify(headers.get('x-sulla-clock-sync-nonce') ?? '', headers.get('x-sulla-clock-sync-signature') ?? '')).toBe(true);
      expect(init?.body).toBe('{}');

      return new Response(null, { status: 200 });
    }, () => nonce);

    await expect(client.synchronize()).resolves.toBeUndefined();
    expect(requestCount).toBe(1);
  });

  it('refuses non-Desktop or ambiguous endpoints before making a request', async() => {
    // risk: secret protection — installation credentials cannot be sent to an attacker-controlled clock endpoint.
    let requestCount = 0;
    const client = new HostClockSyncClient('http://attacker.invalid:3000/internal/runtime/sync-clock', installationSecret, async() => {
      requestCount++;
      return new Response(null, { status: 200 });
    }, () => nonce);

    await expect(client.synchronize()).rejects.toThrow(/trusted Desktop host/);
    expect(requestCount).toBe(0);
  });

  it('fails closed when the host cannot resynchronize the guest clock', async() => {
    // risk: authentication integrity — an unsuccessful host correction must not be treated as a valid resync.
    const client = new HostClockSyncClient(endpoint, installationSecret, async() => new Response(null, { status: 503 }), () => nonce);

    await expect(client.synchronize()).rejects.toThrow(/refused runtime clock synchronization/);
  });
});
