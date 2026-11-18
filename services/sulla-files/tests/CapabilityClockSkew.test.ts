// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyCapabilityToken } from '../src/auth.js';

const key = Buffer.alloc(32, 11);
const tokenIssuedAt = (iat:number) => {
  const encode = (value:unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ v: 1, iss: 'sulla-files', aud: 'sulla-tools', sub: 'test-user', scopes: ['files/*'], iat, exp: iat + 900, jti: 'clock-skew-test' });
  return `${header}.${payload}.${createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url')}`;
};

describe('Files capability clock skew', () => {
  it('accepts 73 seconds of future issue-time skew', () => {
    // risk: authentication availability — bounded host/guest clock drift must not deny writes.
    const now = 1_800_000_000;
    expect(verifyCapabilityToken(tokenIssuedAt(now + 73), key, now).sub).toBe('test-user');
  });

  it('rejects issue-time skew of ten minutes', () => {
    // risk: authentication integrity — capabilities issued too far in the future remain invalid.
    const now = 1_800_000_000;
    expect(() => verifyCapabilityToken(tokenIssuedAt(now + 600), key, now)).toThrow(/clock skew exceeds 300s/);
  });

  it('accepts an expired timestamp within the bounded host/guest skew window', () => {
    // risk: authentication availability — a guest clock ahead by 70 seconds must not deny a fresh 5-minute capability.
    const now = 1_800_000_000;
    expect(verifyCapabilityToken(tokenIssuedAt(now - 973), key, now).sub).toBe('test-user');
  });

  it('still rejects capabilities expired beyond the bounded skew window', () => {
    // risk: authentication integrity — clock tolerance must not turn an expired capability into a long-lived credential.
    const now = 1_800_000_000;
    expect(() => verifyCapabilityToken(tokenIssuedAt(now - 1_201), key, now)).toThrow(/clock skew exceeds 300s/);
  });
});
