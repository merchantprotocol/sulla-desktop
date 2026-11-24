// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { LocalVaultError } from './LocalVaultError.js';

import type { BrokerExecuteResponse } from '../contracts.js';

const MIN_RETRY_DELAY_MS = 250;

/** Sanitizes Clerk retry hints and preserves them when a retry will exceed the request budget. */
export class ClerkRetryPolicy {
  constructor(private readonly now: () => number = Date.now) {}

  retryDelay(value: string | undefined, attempt: number): { ms: number; seconds: number } {
    let parsed = NaN;
    if (value && /^\d+$/.test(value)) {
      const maximumSeconds = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000));
      const seconds = value.length > 16 ? maximumSeconds + 1n : BigInt(value);
      parsed = seconds > maximumSeconds ? Number.MAX_SAFE_INTEGER : Number(seconds) * 1_000;
    } else if (value) {
      parsed = Date.parse(value) - this.now();
    }
    const ms = Number.isFinite(parsed) ? Math.max(MIN_RETRY_DELAY_MS, parsed) : 1_000 * (attempt + 1);
    return { ms, seconds: Math.max(1, Math.ceil(ms / 1_000)) };
  }

  withRetryAfter(result: BrokerExecuteResponse, seconds: number): BrokerExecuteResponse {
    return { ...result, headers: { ...result.headers, 'retry-after': String(seconds) } };
  }

  safeRetryAfter(value: string | undefined): string {
    return String(this.retryDelay(value, 0).seconds);
  }

  rateLimitError(value: string | undefined): LocalVaultError {
    const seconds = this.retryDelay(value, 0).seconds;
    return new LocalVaultError('upstream_failed', 429,
      `Clerk is rate limiting this request. Retry in ${ seconds } second${ seconds === 1 ? '' : 's' }.`, undefined, undefined, seconds);
  }
}
