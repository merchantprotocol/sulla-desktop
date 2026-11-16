// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Broker egress timing constants and the pre-E9 function entry points. The
// diagnostics and recovery decisions live in UpstreamEgressDiagnostics.
//
// Everything here is credential-free by construction: it only ever reads
// errno-style codes, syscalls and address families from socket errors. It
// never sees URLs, paths, query strings, headers or bodies, so its output is
// safe to log and to hand back to callers as a reason code.

import type { PinnedAddress } from './pinnedLookup.js';
import {
  UpstreamEgressDiagnostics,
  type UpstreamErrorDetail, type UpstreamFailureLog, type UpstreamFailurePhase,
} from './UpstreamEgressDiagnostics.js';

export { UpstreamEgressDiagnostics };
export type { UpstreamErrorDetail, UpstreamFailureLog, UpstreamFailurePhase };

/** A fresh socket must finish TCP + TLS within this window or the attempt is treated as a connect timeout. */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 3_000;
/** Happy-eyeballs per-address window. Node's 250 ms default aborts slow-but-working paths (VPNs, tethering). */
export const UPSTREAM_FIRST_ATTEMPT_FAMILY_TIMEOUT_MS = 1_000;
export const UPSTREAM_RETRY_ATTEMPT_FAMILY_TIMEOUT_MS = 3_000;
/** Three attempts plus these short pauses stay inside a roughly ten-second recovery window. */
export const UPSTREAM_RETRY_DELAYS_MS = [250, 750] as const;
export const UPSTREAM_MAX_ATTEMPTS = UPSTREAM_RETRY_DELAYS_MS.length + 1;
/** Seconds a caller should wait before retrying a transient egress failure. */
export const UPSTREAM_RETRY_AFTER_SECONDS = 5;

/** Stateless diagnostics instance behind the deprecated function aliases below. */
const diagnostics = new UpstreamEgressDiagnostics();

/** @deprecated use UpstreamEgressDiagnostics#isNetworkError — E9 alias, removed in final cleanup */
export function isUpstreamNetworkError(error: unknown): boolean {
  return diagnostics.isNetworkError(error);
}

/** @deprecated use UpstreamEgressDiagnostics#describe — E9 alias, removed in final cleanup */
export function describeUpstreamError(error: unknown): UpstreamErrorDetail {
  return diagnostics.describe(error);
}

/** @deprecated use UpstreamEgressDiagnostics#failurePhase — E9 alias, removed in final cleanup */
export function upstreamFailurePhase(code: string, connected: boolean): UpstreamFailurePhase {
  return diagnostics.failurePhase(code, connected);
}

/** @deprecated use UpstreamEgressDiagnostics#failureReason — E9 alias, removed in final cleanup */
export function upstreamFailureReason(phase: UpstreamFailurePhase, code: string): string {
  return diagnostics.failureReason(phase, code);
}

/** @deprecated use UpstreamEgressDiagnostics#isReconnectable — E9 alias, removed in final cleanup */
export function isReconnectableUpstreamError(error: unknown, connected: boolean): boolean {
  return diagnostics.isReconnectable(error, connected);
}

/** @deprecated use UpstreamEgressDiagnostics#retryAddressOrder — E9 alias, removed in final cleanup */
export function retryAddressOrder(addresses: readonly PinnedAddress[], failedAttempts: readonly string[]): PinnedAddress[] {
  return diagnostics.retryAddressOrder(addresses, failedAttempts);
}

/** @deprecated use UpstreamEgressDiagnostics#familySummary — E9 alias, removed in final cleanup */
export function familySummary(addresses: readonly PinnedAddress[]): string {
  return diagnostics.familySummary(addresses);
}

/** @deprecated use UpstreamEgressDiagnostics#formatFailureLog — E9 alias, removed in final cleanup */
export function formatUpstreamFailureLog(entry: UpstreamFailureLog): string {
  return diagnostics.formatFailureLog(entry);
}
