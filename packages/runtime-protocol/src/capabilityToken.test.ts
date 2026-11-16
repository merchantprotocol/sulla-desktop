// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueCapabilityToken, verifyCapabilityToken, CapabilityTokenError } from './capabilityToken.js';

const key = Buffer.alloc(32, 7);
const token = (expiresInSeconds: number) => issueCapabilityToken({ sub: 'test-user', scopes: ['files/*'], expiresInSeconds }, key);
const tokenIssuedAt = (iat: number) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ v: 1, iss: 'sulla-desktop', aud: 'sulla-tools', sub: 'test-user', scopes: ['files/*'], iat, exp: iat + 900, jti: 'future-clock-test' });
  return `${header}.${payload}.${crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')}`;
};

describe('capability token clock tolerance', () => {
  it('accepts a capability issued 73 seconds in the future', async () => {
    // risk: authentication availability during host/guest clock drift
    const issued = Math.floor(Date.now() / 1000);
    await expect(verifyCapabilityToken(tokenIssuedAt(issued + 73), key, { now: issued })).resolves.toMatchObject({ sub: 'test-user' });
  });

  it('rejects a capability issued 10 minutes in the future', async () => {
    // risk: authentication integrity; stale capabilities must still expire
    const issued = Math.floor(Date.now() / 1000);
    await expect(verifyCapabilityToken(tokenIssuedAt(issued + 600), key, { now: issued })).rejects.toMatchObject({
      code: 'not_yet_valid', message: expect.stringMatching(/issued .*s in the future.*skew/),
    } satisfies Partial<CapabilityTokenError>);
  });

  it('keeps the existing 60 second expiry grace despite the wider future-iat window', async () => {
    // risk: authentication integrity — clock-skew tolerance must not extend expiration.
    const issued = Math.floor(Date.now() / 1000);
    await expect(verifyCapabilityToken(token(1), key, { now: issued + 62 })).rejects.toMatchObject({
      code: 'expired', message: expect.stringMatching(/expired .*s ago.*60s tolerance/),
    } satisfies Partial<CapabilityTokenError>);
  });
});
