// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Decides whether a database error is a passing outage (retry / 503) or a real failure.
 *
 * Postgres being down, restarting or still starting is expected (container
 * restarts, VM resume). Only connection-class failures are retried; real SQL
 * or migration errors still fail fast.
 *
 * Generic socket errors (EAI_AGAIN, ETIMEDOUT, ...) only count when they came
 * from the Postgres connection. The same codes from an upstream fetch
 * (Anthropic, OpenAI, Sulla Cloud) are egress failures, not a database outage.
 */
export class VaultDatabaseErrorClassifier {
  private static readonly transientNetworkCodes: ReadonlySet<string> = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  ]);

  /** `environment` is read on every call (no cached state), like the original module did with process.env. */
  constructor(private readonly environment: () => NodeJS.ProcessEnv = () => process.env) {}

  isTransient(error: unknown): boolean {
    const e = error as { code?: unknown; message?: unknown; errors?: unknown[]; hostname?: unknown; address?: unknown; port?: unknown } | null;
    if (!e || typeof e !== 'object') return false;
    const code = typeof e.code === 'string' ? e.code : '';
    // 57P01-3 admin shutdown / crash / cannot connect now, 08xxx connection exceptions, 53300 too many connections.
    if (/^(57P0[123]|08|53300)/.test(code)) return true;
    if (VaultDatabaseErrorClassifier.transientNetworkCodes.has(code)) return this.networkErrorTargetsDatabase(e);
    if (Array.isArray(e.errors) && e.errors.length && e.errors.every((inner) => this.isTransient(inner))) return true;
    return typeof e.message === 'string' && /Connection terminated|connection.*(?:closed|ended)|timeout exceeded when trying to connect/i.test(e.message);
  }

  /** One short line for an error; never the full pg client/pool object. */
  describe(error: unknown): string {
    const e = error as { code?: string; message?: string } | null;
    return [e?.code, e?.message?.split('\n')[0]].filter(Boolean).join(' ') || 'unknown error';
  }

  /** Host and port of the configured Postgres (read on demand), so socket errors can be attributed to it or not. */
  private databaseEndpoint(): { host: string; port: number } | null {
    const connectionString = this.environment().SULLA_VAULT_DATABASE_URL;
    if (!connectionString) return null;
    try {
      const url = new URL(connectionString);
      return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || 5432 };
    } catch {
      return null; // unparseable URL: keep the permissive classification
    }
  }

  /** Does a socket-level error (EAI_AGAIN, ECONNRESET, ...) point at Postgres rather than some other host? */
  private networkErrorTargetsDatabase(e: { hostname?: unknown; address?: unknown; port?: unknown }): boolean {
    const endpoint = this.databaseEndpoint();
    if (!endpoint) return true; // endpoint unknown (startup wait, tests): legacy behavior
    if (typeof e.hostname === 'string') return e.hostname === endpoint.host;
    if (typeof e.port === 'number' && e.port !== endpoint.port) return false;
    if (typeof e.address === 'string' && e.port === undefined) return e.address === endpoint.host;
    // No host/port on the error: pg reports e.g. ECONNRESET on an established pool socket this way.
    return typeof e.port === 'number' ? e.port === endpoint.port : true;
  }
}
