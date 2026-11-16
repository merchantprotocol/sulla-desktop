// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// E9 characterization: broker egress diagnostics (retry decisions, phases,
// reason codes, address ordering, log lines) must equal the verbatim legacy
// copy of upstreamEgress.ts at ddbe28884 for every input. Pure functions: no
// network is touched; socket errors are plain fixtures.

import { describe, expect, it } from 'vitest';

import * as current from '../../../../../../services/sulla-vault/src/upstreamEgress';
import * as legacy from '../../Support/E9Legacy/upstreamEgress.legacy';

import type { PinnedAddress } from '../../../../../../services/sulla-vault/src/pinnedLookup';

const CODES = [
  'EADDRNOTAVAIL', 'EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETDOWN',
  'ENETRESET', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'UPSTREAM_CONNECT_TIMEOUT',
  'ENOTFOUND', 'EAI_FAIL', 'EAI_NODATA', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'HOSTNAME_MISMATCH',
  'ERR_OSSL_EVP_BAD_DECRYPT', 'EACCES', 'ERR_INVALID_URL', 'econnrefused', '', 'E!C@O#N$N', 'X'.repeat(60), 'unknown',
];

class ErrorFixtures {
  static all(): unknown[] {
    const fixtures: unknown[] = [null, undefined, 'ECONNREFUSED', 42, true, {}, [], new Error('no code')];
    for (const code of CODES) {
      fixtures.push({ code });
      fixtures.push(Object.assign(new Error(code), { code, syscall: 'connect', address: '10.0.0.1', port: 443 }));
      fixtures.push(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code, syscall: 'getaddrinfo' }) }));
      fixtures.push({ code: 'EWRAPPER', cause: { code } });
      fixtures.push({ errors: [{ code, address: '2001:db8::1' }, { code, address: '192.0.2.1' }] });
      fixtures.push({ code, address: '2001:db8::1', syscall: 'conn ect;rm' });
    }
    fixtures.push({ code: 7 });
    fixtures.push({ code: 7, cause: { code: 'ECONNRESET' } });
    fixtures.push({ syscall: 12345, address: '::1' });
    fixtures.push({ errors: [] });
    fixtures.push({ errors: [{ code: 'ENETUNREACH', address: '::1' }, { code: 'ECONNREFUSED', address: '127.0.0.1' }] });
    fixtures.push({ errors: [{ code: 'ENETUNREACH', address: '::1' }, { code: 'EACCES', address: '127.0.0.1' }] });
    fixtures.push({ errors: [{ code: 'EACCES' }, { address: '::1' }, null, { code: 'ETIMEDOUT', address: '' }] });
    fixtures.push({ errors: Array.from({ length: 10 }, (_, index) => ({ code: index % 2 ? 'ETIMEDOUT' : 'ENETUNREACH', address: index % 2 ? '198.51.100.1' : '::1' })) });
    fixtures.push(Object.assign(new AggregateError([
      Object.assign(new Error('a'), { code: 'ENETUNREACH', address: '2001:db8::2' }),
      Object.assign(new Error('b'), { code: 'ETIMEDOUT', address: '203.0.113.9' }),
    ], 'connect failed'), { code: 'ETIMEDOUT' }));
    fixtures.push(new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED', address: '::1' })], 'no code on wrapper'));
    fixtures.push(new TypeError('fetch failed', { cause: new AggregateError([{ code: 'EHOSTUNREACH', address: '192.0.2.4' }], 'x') }));
    const self: Record<string, unknown> = { message: 'self cause' };
    self.cause = self;
    fixtures.push(self);
    fixtures.push({ cause: { cause: { cause: { code: 'EAI_AGAIN' } } } });
    fixtures.push({ cause: undefined, code: undefined });
    fixtures.push({ address: 42, code: 'ECONNRESET' });
    return fixtures;
  }
}

const ADDRESSES: PinnedAddress[][] = [
  [],
  [{ address: '192.0.2.1', family: 4 }],
  [{ address: '2001:db8::1', family: 6 }],
  [{ address: '2001:db8::1', family: 6 }, { address: '192.0.2.1', family: 4 }, { address: '2001:db8::2', family: 6 }, { address: '192.0.2.2', family: 4 }],
  [{ address: '192.0.2.1', family: 4 }, { address: '192.0.2.2', family: 4 }],
];

const ATTEMPTS: string[][] = [
  [], ['v6:ENETUNREACH'], ['v4:ETIMEDOUT'], ['v6:ENETUNREACH', 'v6:EHOSTUNREACH'], ['v6:ENETUNREACH', 'v4:ETIMEDOUT'],
  ['v?:unknown'], ['v?:unknown', 'v6:ENETUNREACH'], ['garbage'], ['v4'],
];

const PHASES = ['dns', 'connect', 'tls', 'socket'] as const;

describe('E9 upstreamEgress: decisions equal legacy copy', () => {
  it('exports the same timing constants', () => {
    // risk: availability — retry windows and caller back-off must not drift.
    expect(current.UPSTREAM_CONNECT_TIMEOUT_MS).toBe(legacy.UPSTREAM_CONNECT_TIMEOUT_MS);
    expect(current.UPSTREAM_FIRST_ATTEMPT_FAMILY_TIMEOUT_MS).toBe(legacy.UPSTREAM_FIRST_ATTEMPT_FAMILY_TIMEOUT_MS);
    expect(current.UPSTREAM_RETRY_ATTEMPT_FAMILY_TIMEOUT_MS).toBe(legacy.UPSTREAM_RETRY_ATTEMPT_FAMILY_TIMEOUT_MS);
    expect(current.UPSTREAM_RETRY_DELAYS_MS).toEqual(legacy.UPSTREAM_RETRY_DELAYS_MS);
    expect(current.UPSTREAM_MAX_ATTEMPTS).toBe(legacy.UPSTREAM_MAX_ATTEMPTS);
    expect(current.UPSTREAM_RETRY_AFTER_SECONDS).toBe(legacy.UPSTREAM_RETRY_AFTER_SECONDS);
    expect([current.UPSTREAM_CONNECT_TIMEOUT_MS, current.UPSTREAM_MAX_ATTEMPTS, current.UPSTREAM_RETRY_AFTER_SECONDS]).toEqual([3000, 3, 5]);
  });

  it('classifies, describes and decides retries identically for every error shape', () => {
    // risk: credential leakage + retry safety — a reconnect after bytes were sent would replay a request.
    for (const [index, error] of ErrorFixtures.all().entries()) {
      const label = `fixture#${ index }`;
      expect(current.isUpstreamNetworkError(error), label).toBe(legacy.isUpstreamNetworkError(error));
      expect(current.describeUpstreamError(error), label).toEqual(legacy.describeUpstreamError(error));
      expect(current.isReconnectableUpstreamError(error, false), label).toBe(legacy.isReconnectableUpstreamError(error, false));
      expect(current.isReconnectableUpstreamError(error, true), label).toBe(false);
      expect(legacy.isReconnectableUpstreamError(error, true), label).toBe(false);
    }
  });

  it('works as an Array#every callback the same way', () => {
    // risk: retry safety — callers pass the function by reference.
    const errors = [{ code: 'ECONNRESET' }, { code: 'EAI_AGAIN' }];
    expect(errors.every(current.isUpstreamNetworkError)).toBe(errors.every(legacy.isUpstreamNetworkError));
    expect([...errors, { code: 'EACCES' }].every(current.isUpstreamNetworkError)).toBe(false);
  });

  it('maps codes to phases and reason codes identically', () => {
    // risk: leakage — reason codes are returned to callers and must stay sanitized.
    for (const code of CODES) {
      for (const connected of [false, true]) {
        expect(current.upstreamFailurePhase(code, connected), code).toBe(legacy.upstreamFailurePhase(code, connected));
      }
      for (const phase of PHASES) {
        expect(current.upstreamFailureReason(phase, code), code).toBe(legacy.upstreamFailureReason(phase, code));
      }
    }
    expect(current.upstreamFailureReason('connect', 'ECONNREFUSED')).toBe('connect_ECONNREFUSED');
    expect(current.upstreamFailurePhase('EAI_AGAIN', true)).toBe('dns');
    expect(current.upstreamFailurePhase('CERT_HAS_EXPIRED', false)).toBe('tls');
  });

  it('orders retry addresses and summarizes families identically', () => {
    // risk: availability — a dead address family must not be retried first.
    for (const addresses of ADDRESSES) {
      expect(current.familySummary(addresses)).toBe(legacy.familySummary(addresses));
      for (const attempts of ATTEMPTS) {
        const result = current.retryAddressOrder(addresses, attempts);
        expect(result, JSON.stringify({ addresses, attempts })).toEqual(legacy.retryAddressOrder(addresses, attempts));
        expect(result).not.toBe(addresses);
      }
    }
  });

  it('formats the same credential-free log line', () => {
    // risk: credential leakage — log lines carry hostname only, sanitized.
    const details = [
      { code: 'ECONNREFUSED', syscall: 'connect', attempts: ['v6:ENETUNREACH', 'v4:ECONNREFUSED'] },
      { code: 'unknown', attempts: [] },
    ];
    for (const detail of details) {
      for (const hostname of ['api.example.test', '[2001:db8::1]', 'evil.test/path?token=secret', 'h'.repeat(300)]) {
        for (const operation of ['integration.request', 'op with spaces&token=1', 'o'.repeat(100)]) {
          for (const willRetry of [false, true]) {
            const entry = {
              operation, hostname, attempt: 2, maxAttempts: 3, phase: 'connect' as const, detail,
              families: 'v6,v4', reusedSocket: willRetry, willRetry,
            };
            expect(current.formatUpstreamFailureLog(entry)).toBe(legacy.formatUpstreamFailureLog(entry));
          }
        }
      }
    }
  });

  it('overflows the stack the same way on a two-object cause cycle', () => {
    // Pins current behaviour (see bugs_found): only a direct self-cause is guarded.
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { cause: a };
    a.cause = b;
    expect(() => legacy.isUpstreamNetworkError(a)).toThrow(RangeError);
    expect(() => current.isUpstreamNetworkError(a)).toThrow(RangeError);
    expect(() => legacy.describeUpstreamError(a)).toThrow(RangeError);
    expect(() => current.describeUpstreamError(a)).toThrow(RangeError);
  });
});
