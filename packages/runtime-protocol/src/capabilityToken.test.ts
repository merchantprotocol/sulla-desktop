// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { issueCapabilityToken, verifyCapabilityToken, CapabilityTokenError } from './capabilityToken.js';

const key = Buffer.alloc(32, 7);
const token = (expiresInSeconds: number) => issueCapabilityToken({ sub: 'test-user', scopes: ['files/*'], expiresInSeconds }, key);

describe('capability token clock tolerance', () => {
  it('accepts tokens within the configured 60 second skew', async () => {
    // risk: authentication availability during host/guest clock drift
    const issued = Math.floor(Date.now() / 1000);
    await expect(verifyCapabilityToken(token(1), key, { now: issued + 60 })).resolves.toMatchObject({ sub: 'test-user' });
  });

  it('rejects tokens beyond tolerance with an explicit skew reason', async () => {
    // risk: authentication integrity; stale capabilities must still expire
    const issued = Math.floor(Date.now() / 1000);
    await expect(verifyCapabilityToken(token(1), key, { now: issued + 62 })).rejects.toMatchObject({
      code: 'expired', message: expect.stringMatching(/expired .*s ago.*skew/),
    } satisfies Partial<CapabilityTokenError>);
  });
});
