// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The fetch Desktop sends Sulla Cloud requests with. Tests pass a fake; production uses the global fetch at call time. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Unauthenticated HTTP to the Sulla Cloud workers API (what `cloudFetch` in sullaCloudAuth.ts did): every request gets
 * a 20 s timeout, and `retry` repeats a request ONCE after 500 ms when it failed without an HTTP response. Knows no
 * paths; the account endpoints live in ElectronCloudAccountTransport.
 */
export class SullaCloudHttpClient {
  static readonly API_BASE = 'https://sulla-workers.merchantprotocol.workers.dev';

  constructor(
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
    private readonly baseUrl: string = SullaCloudHttpClient.API_BASE,
    private readonly timeoutMs = 20_000,
    private readonly retryDelayMs = 500,
  ) {}

  /** The caller's `signal` is replaced by the client timeout, exactly as before. */
  async send(path: string, init: RequestInit, retry = false): Promise<Response> {
    const attempts = retry ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.fetchFn(`${ this.baseUrl }${ path }`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw lastError;
  }
}
