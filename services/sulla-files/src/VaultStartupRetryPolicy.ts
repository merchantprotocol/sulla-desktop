// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesSafeDiagnosticError, type VaultAuthorityOperation } from './startupDiagnostics.js';

export interface VaultStartupRetryOptions {
  windowMs?:       number;
  initialDelayMs?: number;
  maxDelayMs?:     number;
  retryableCodes?: Iterable<string>;
  now?:            () => number;
  sleep?:          (milliseconds:number) => Promise<void>;
}

/**
 * Retries a Vault authority call while Vault is still starting (locked 423, or
 * the socket is not up yet) with capped exponential backoff for up to two
 * minutes. Auth failures (401/403) and everything else fail immediately.
 * Each authority owns its own policy instance; nothing is shared between them.
 */
export class VaultStartupRetryPolicy {
  static readonly defaultRetryableCodes:readonly string[] = Object.freeze(['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT']);

  private readonly windowMs:       number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs:     number;
  private readonly retryableCodes: ReadonlySet<string>;
  private readonly now:            () => number;
  private readonly sleep:          (milliseconds:number) => Promise<void>;

  constructor(options:VaultStartupRetryOptions = {}) {
    this.windowMs = options.windowMs ?? 2 * 60 * 1000;
    this.initialDelayMs = options.initialDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 5 * 1000;
    this.retryableCodes = new Set(options.retryableCodes ?? VaultStartupRetryPolicy.defaultRetryableCodes);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  }

  isRetryable(error:unknown):boolean {
    if (error instanceof FilesSafeDiagnosticError) {
      const diagnostic = error.diagnostic;
      if (diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403) return false;
      if (diagnostic.httpStatus === 423) return true;
    }
    let current:unknown = error;
    for (let depth = 0; depth < 3 && current; depth++) {
      if (typeof current === 'object' && current !== null && 'code' in current &&
          typeof current.code === 'string' && this.retryableCodes.has(current.code)) return true;
      current = typeof current === 'object' && current !== null && 'cause' in current ? current.cause : undefined;
    }
    return false;
  }

  async run<T>(operation:VaultAuthorityOperation, attempt:() => Promise<T>):Promise<T> {
    const startedAt = this.now();
    let delay = this.initialDelayMs;
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (!this.isRetryable(error) || this.now() - startedAt >= this.windowMs) throw error;
        console.warn(`[SullaFiles] Vault unavailable; retrying ${ operation } in ${ delay }ms`);
        await this.sleep(delay);
        delay = Math.min(delay * 2, this.maxDelayMs);
      }
    }
  }
}
