// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CapabilityTokenClockRecovery } from './CapabilityTokenClockRecovery.js';

const signingKey = Buffer.alloc(32, 31);

function signedToken(iat: number, exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: 'test-user', scopes: ['files/read'], iat, exp, jti: `test-${ iat }-${ exp }` });
  const signature = crypto.createHmac('sha256', signingKey).update(`${ header }.${ payload }`).digest('base64url');

  return `${ header }.${ payload }.${ signature }`;
}

describe('capability token clock recovery', () => {
  it('does not resync for a forged signature', async() => {
    // risk: authentication integrity — forged capabilities must not trigger or pass recovery.
    let syncCalls = 0;
    const recovery = new CapabilityTokenClockRecovery(async() => { syncCalls++; }, () => 1_000);
    const token = signedToken(1_000, 2_000);
    const parts = token.split('.');
    parts[2] = `${ parts[2].slice(0, -1) }${ parts[2].endsWith('A') ? 'B' : 'A' }`;

    await expect(recovery.verify(parts.join('.'), signingKey)).rejects.toMatchObject({ code: 'invalid' });
    expect(syncCalls).toBe(0);
  });

  it('still rejects a token expired at the corrected host time', async() => {
    // risk: authentication integrity — host resync must not extend actual token expiry.
    let now = 2_000;
    let syncCalls = 0;
    const recovery = new CapabilityTokenClockRecovery(async() => { syncCalls++; now = 1_600; }, () => now);

    await expect(recovery.verify(signedToken(1_000, 1_500), signingKey)).rejects.toMatchObject({ code: 'expired' });
    expect(syncCalls).toBe(1);
  });

  it('accepts a signed future-issued token only after resync brings it within the 300-second bound', async() => {
    // risk: authentication availability without widening the documented 300-second verification bound.
    let now = 1_000;
    let syncCalls = 0;
    const recovery = new CapabilityTokenClockRecovery(async() => { syncCalls++; now = 1_300; }, () => now);

    await expect(recovery.verify(signedToken(1_600, 2_200), signingKey)).resolves.toMatchObject({ sub: 'test-user' });
    expect(syncCalls).toBe(1);
  });

  it('rechecks revocation after resync so a revoked capability cannot be replayed', async() => {
    // risk: replay protection — clock recovery must not bypass the jti revocation store.
    let now = 1_000;
    let syncCalls = 0;
    let revocationChecks = 0;
    const revocations = {
      isRevoked: async() => { revocationChecks++; return true; },
      revoke:    async() => undefined,
    };
    const recovery = new CapabilityTokenClockRecovery(async() => { syncCalls++; now = 1_300; }, () => now);

    await expect(recovery.verify(signedToken(1_600, 2_200), signingKey, { revocations })).rejects.toMatchObject({ code: 'revoked' });
    expect(syncCalls).toBe(1);
    expect(revocationChecks).toBe(1);
  });

  it('recovers when the guest clock jumped ahead, then evaluates expiry against corrected time', async() => {
    // risk: authentication availability after a forward guest-clock jump; expiry remains host-time checked.
    let now = 2_200;
    let syncCalls = 0;
    const recovery = new CapabilityTokenClockRecovery(async() => { syncCalls++; now = 1_600; }, () => now);

    await expect(recovery.verify(signedToken(1_000, 1_700), signingKey)).resolves.toMatchObject({ sub: 'test-user' });
    expect(syncCalls).toBe(1);
  });

  it('rejects skew beyond 300 seconds when authenticated resync fails', async() => {
    // risk: authentication integrity — failed sync cannot bypass the strict future-issued bound.
    let syncCalls = 0;
    const recovery = new CapabilityTokenClockRecovery(async() => { syncCalls++; throw new Error('unavailable'); }, () => 1_000);

    await expect(recovery.verify(signedToken(1_601, 2_500), signingKey)).rejects.toMatchObject({ code: 'not_yet_valid' });
    expect(syncCalls).toBe(1);
  });
});
