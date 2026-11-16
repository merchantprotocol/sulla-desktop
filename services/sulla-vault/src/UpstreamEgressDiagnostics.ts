// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Broker egress diagnostics and connect-phase recovery decisions (E9: pure
// move out of upstreamEgress.ts; method bodies are the former functions).
//
// Everything here is credential-free by construction: it only ever reads
// errno-style codes, syscalls and address families from socket errors. It
// never sees URLs, paths, query strings, headers or bodies, so its output is
// safe to log and to hand back to callers as a reason code.

import type { PinnedAddress } from './pinnedLookup.js';

export type UpstreamFailurePhase = 'dns' | 'connect' | 'tls' | 'socket';

export interface UpstreamErrorDetail {
  /** errno-style code (ECONNREFUSED, EAI_AGAIN, ERR_TLS_…) or `unknown`. */
  code:     string;
  syscall?: string;
  /** Per-address attempts from Node's family autoselection, e.g. `v6:ENETUNREACH`. Never addresses. */
  attempts: string[];
}

export interface UpstreamFailureLog {
  operation: string;
  hostname:  string;
  attempt:   number;
  maxAttempts: number;
  phase:     UpstreamFailurePhase;
  detail:    UpstreamErrorDetail;
  families:  string;
  reusedSocket: boolean;
  willRetry: boolean;
}

export class UpstreamEgressDiagnostics {
  /**
   * Socket error codes that mean "this path to the host did not work right now".
   * A connect-phase failure with one of these is retried once with freshly
   * resolved addresses, because nothing was sent upstream yet.
   */
  private readonly reconnectableCodes: ReadonlySet<string> = new Set([
    'EADDRNOTAVAIL',
    'EAI_AGAIN',
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTDOWN',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETRESET',
    'ENETUNREACH',
    'EPIPE',
    'ETIMEDOUT',
    'ERR_SOCKET_CONNECTION_TIMEOUT',
    'UPSTREAM_CONNECT_TIMEOUT',
  ]);

  private readonly tlsCode = /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|HOSTNAME_MISMATCH|ERR_OSSL_)/;

  /**
   * True for a socket/DNS failure from an outbound fetch (also unwraps undici's
   * `TypeError: fetch failed` whose real code sits on `cause`). Callers must
   * check isTransientDbError first: a Postgres socket error has the same codes.
   */
  isNetworkError(error: unknown): boolean {
    const e = error as { code?: unknown; cause?: unknown; errors?: unknown[] } | null;
    if (!e || typeof e !== 'object') return false;
    const code = typeof e.code === 'string' ? e.code : '';
    if (this.reconnectableCodes.has(code) || code === 'ENOTFOUND' || code === 'EAI_FAIL' || code === 'EAI_NODATA') return true;
    if (Array.isArray(e.errors) && e.errors.length && e.errors.every(entry => this.isNetworkError(entry))) return true;
    return e.cause !== undefined && e.cause !== error && this.isNetworkError(e.cause);
  }

  /** Read only errno/syscall/family facts from a socket error (including Node's AggregateError). */
  describe(error: unknown): UpstreamErrorDetail {
    const value = error as { code?: unknown; syscall?: unknown; errors?: unknown; address?: unknown; cause?: unknown } | undefined;
    // undici wraps the socket error: `TypeError: fetch failed` with the real errno on `cause`.
    if (value && typeof value.code !== 'string' && value.cause && value.cause !== error) return this.describe(value.cause);
    const nested = Array.isArray(value?.errors) ? value!.errors as Array<{ code?: unknown; address?: unknown }> : [];
    const attempts = nested
      .map(entry => `${ this.familyOf(entry?.address) ?? 'v?' }:${ this.safeToken(entry?.code) ?? 'unknown' }`)
      .slice(0, 8);
    if (!attempts.length && this.familyOf(value?.address)) attempts.push(`${ this.familyOf(value?.address) }:${ this.safeToken(value?.code) ?? 'unknown' }`);
    const code = this.safeToken(value?.code) ?? this.safeToken(nested.find(entry => this.safeToken(entry?.code))?.code) ?? 'unknown';
    return { code, syscall: this.safeToken(value?.syscall), attempts };
  }

  failurePhase(code: string, connected: boolean): UpstreamFailurePhase {
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_FAIL' || code === 'EAI_NODATA') return 'dns';
    if (this.tlsCode.test(code)) return 'tls';
    return connected ? 'socket' : 'connect';
  }

  /** Non-secret reason code returned to broker callers, e.g. `connect_ECONNREFUSED`. */
  failureReason(phase: UpstreamFailurePhase, code: string): string {
    return `${ phase }_${ code }`.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
  }

  /** True when nothing reached the upstream yet and the failure looks like a path/DNS problem. */
  isReconnectable(error: unknown, connected: boolean): boolean {
    if (connected) return false;
    const detail = this.describe(error);
    if (this.reconnectableCodes.has(detail.code)) return true;
    return detail.attempts.some(attempt => this.reconnectableCodes.has(attempt.slice(attempt.indexOf(':') + 1)));
  }

  /**
   * Order freshly resolved addresses for the retry: if every failed attempt was
   * on one family, lead with the other family so a dead IPv6 (or IPv4) route
   * after a network change is not the first thing tried again.
   */
  retryAddressOrder(addresses: readonly PinnedAddress[], failedAttempts: readonly string[]): PinnedAddress[] {
    const failedFamilies = new Set(failedAttempts.map(attempt => attempt.split(':')[0]).filter(family => family === 'v4' || family === 'v6'));
    if (failedFamilies.size !== 1) return [...addresses];
    const failed = failedFamilies.has('v6') ? 6 : 4;
    return [
      ...addresses.filter(candidate => candidate.family !== failed),
      ...addresses.filter(candidate => candidate.family === failed),
    ];
  }

  familySummary(addresses: readonly PinnedAddress[]): string {
    const families = [...new Set(addresses.map(candidate => `v${ candidate.family }`))];
    return families.join(',') || 'none';
  }

  /** One credential-free log line. Hostname only; never the path, query, headers or body. */
  formatFailureLog(entry: UpstreamFailureLog): string {
    const host = entry.hostname.replace(/[^A-Za-z0-9.:[\]-]/g, '').slice(0, 253);
    const operation = entry.operation.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 80);
    return `[VaultBroker] upstream_failed op=${ operation } host=${ host } attempt=${ entry.attempt }/${ entry.maxAttempts } ` +
      `phase=${ entry.phase } code=${ entry.detail.code }${ entry.detail.syscall ? ` syscall=${ entry.detail.syscall }` : '' } ` +
      `families=${ entry.families }${ entry.detail.attempts.length ? ` tried=${ entry.detail.attempts.join(',') }` : '' } ` +
      `reused=${ entry.reusedSocket } retry=${ entry.willRetry ? 'yes' : 'no' }`;
  }

  private safeToken(value: unknown): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const text = String(value).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48);
    return text || undefined;
  }

  private familyOf(address: unknown): 'v4' | 'v6' | undefined {
    if (typeof address !== 'string' || !address) return undefined;
    return address.includes(':') ? 'v6' : 'v4';
  }
}
