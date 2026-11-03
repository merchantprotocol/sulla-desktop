// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  describeUpstreamError, formatUpstreamFailureLog, isReconnectableUpstreamError, retryAddressOrder,
  UPSTREAM_MAX_ATTEMPTS, UPSTREAM_RETRY_DELAYS_MS, upstreamFailurePhase, upstreamFailureReason,
} from './upstreamEgress.js';

describe('upstream egress recovery', () => {
  it('recognizes only connect-phase path failures as safe to retry', () => {
    expect(isReconnectableUpstreamError(Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' }), false)).toBe(true);
    expect(isReconnectableUpstreamError(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), true)).toBe(false);
    expect(isReconnectableUpstreamError(Object.assign(new Error('bad certificate'), { code: 'CERT_HAS_EXPIRED' }), false)).toBe(false);
    expect(UPSTREAM_MAX_ATTEMPTS).toBe(3);
    expect(UPSTREAM_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(1_000);
  });

  it('prefers the other address family after one family fails', () => {
    const addresses = [
      { address: '2001:db8::1', family: 6 as const },
      { address: '192.0.2.1', family: 4 as const },
    ];
    expect(retryAddressOrder(addresses, ['v6:ENETUNREACH'])).toEqual([addresses[1], addresses[0]]);
  });

  it('logs errno, syscall, hostname, and address family without URL data', () => {
    const detail = describeUpstreamError(Object.assign(new Error('secret-bearing message'), {
      code: 'ETIMEDOUT', syscall: 'connect', address: '2001:db8::1',
    }));
    const line = formatUpstreamFailureLog({
      operation: 'broker.request', hostname: 'api.example.test', attempt: 1, maxAttempts: 3,
      phase: upstreamFailurePhase(detail.code, false), detail, families: 'v4,v6', reusedSocket: false, willRetry: true,
    });

    expect(line).toContain('host=api.example.test');
    expect(line).toContain('code=ETIMEDOUT');
    expect(line).toContain('syscall=connect');
    expect(line).toContain('tried=v6:ETIMEDOUT');
    expect(line).not.toContain('secret-bearing');
    expect(upstreamFailureReason('connect', detail.code)).toBe('connect_ETIMEDOUT');
  });
});
