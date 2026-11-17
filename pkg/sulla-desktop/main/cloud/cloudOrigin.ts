// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Production Sulla Cloud origin. Used whenever no valid override is set. */
export const PRODUCTION_CLOUD_ORIGIN = 'https://sulla-workers.merchantprotocol.workers.dev';

/** Env var that points Desktop at a non-production Cloud (staging or a Wrangler preview). */
export const CLOUD_ORIGIN_ENV = 'SULLA_CLOUD_ORIGIN';

const LOCAL_HTTP_HOSTS = new Set(['localhost', '127.0.0.1']);

export interface CloudOriginLogger {
  log(message: string): void;
  warn(message: string): void;
}

/** The result of reading the override: the origin to use and whether it came from the env. */
export interface CloudOriginSelection {
  readonly origin: string;
  readonly overridden: boolean;
  /** Set when an override was supplied but rejected; the production origin is used instead. */
  readonly rejectedReason?: string;
}

/**
 * Resolves the Sulla Cloud origin once from a raw override value and derives the relay socket
 * origin from it. Holds no global state: construct it with the value under test in specs.
 *
 * Rules:
 * - unset or blank → production origin, silently.
 * - `https://<host>` → accepted.
 * - `http://localhost` or `http://127.0.0.1` (any port) → accepted for `wrangler dev`.
 * - anything else (other schemes, other http hosts, paths, query, hash, credentials, unparsable) → rejected,
 *   production origin is used, and the reason is reported.
 */
export class CloudOriginResolver {
  readonly selection: CloudOriginSelection;
  private readonly logger: CloudOriginLogger;

  constructor(rawOverride: string | undefined, logger: CloudOriginLogger) {
    this.logger = logger;
    this.selection = CloudOriginResolver.select(rawOverride);
  }

  /** Logs once: a warning if an override was rejected, or an info line if one is active. */
  announce(): void {
    if (this.selection.rejectedReason) {
      this.logger.warn(`[cloud] ${ CLOUD_ORIGIN_ENV } ignored: ${ this.selection.rejectedReason }. Using ${ PRODUCTION_CLOUD_ORIGIN }.`);
      return;
    }
    if (this.selection.overridden) {
      this.logger.log(`[cloud] ${ CLOUD_ORIGIN_ENV } override active: Sulla Cloud origin is ${ this.selection.origin }`);
    }
  }

  /** HTTP(S) origin for every desktop → cloud request. */
  get httpOrigin(): string {
    return this.selection.origin;
  }

  /** WebSocket origin for the relay: https → wss, http → ws. */
  get relayOrigin(): string {
    return CloudOriginResolver.toWebSocketOrigin(this.selection.origin);
  }

  static toWebSocketOrigin(httpOrigin: string): string {
    return httpOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  }

  private static select(rawOverride: string | undefined): CloudOriginSelection {
    const raw = (rawOverride ?? '').trim();
    if (!raw) return { origin: PRODUCTION_CLOUD_ORIGIN, overridden: false };

    const reason = CloudOriginResolver.rejectionReason(raw);
    if (reason) return { origin: PRODUCTION_CLOUD_ORIGIN, overridden: false, rejectedReason: reason };
    return { origin: new URL(raw).origin, overridden: true };
  }

  /** Returns why a raw override is unusable, or null when it is a valid origin. */
  private static rejectionReason(raw: string): string | null {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return 'the value is not a valid URL';
    }
    const isBareOrigin = (url.pathname === '' || url.pathname === '/') && !url.search && !url.hash && !url.username && !url.password;
    if (!isBareOrigin) return 'the value must be an origin only (no path, query, hash or credentials)';
    if (url.protocol === 'https:') return null;
    if (url.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(url.hostname)) return null;
    if (url.protocol === 'http:') return 'plain http is only allowed for localhost or 127.0.0.1';
    return 'the value must be an https:// URL';
  }
}
