// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Waits at start-up until Postgres answers, instead of crashing on the first miss.
 *
 * Services start together with Postgres; until its container is up Docker DNS has no
 * `postgres` name yet (getaddrinfo ENOTFOUND) and then the server refuses or is still
 * starting (57P03). Those are retried with capped exponential backoff. Anything else
 * (bad password, missing database, SQL errors) is thrown at once, and so is the last
 * error when the deadline passes: ProcessGuard then exits and Docker restarts the
 * service, as before.
 *
 * Each service keeps its own copy because every service image builds from its own folder.
 */
export interface StartupDatabaseWaitOptions {
  /** Log prefix, e.g. sulla-accounts. */
  name:          string;
  /** Give up after this long and let the process exit. */
  deadlineMs?:   number;
  initialDelayMs?: number;
  maxDelayMs?:   number;
  /** Injectable for tests. */
  sleep?:        (ms: number) => Promise<void>;
  now?:          () => number;
  log?:          Pick<Console, 'warn' | 'log'>;
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
]);

export class StartupDatabaseWait {
  readonly #name: string;
  readonly #deadlineMs: number;
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #log: Pick<Console, 'warn' | 'log'>;

  constructor(options: StartupDatabaseWaitOptions) {
    this.#name = options.name;
    this.#deadlineMs = options.deadlineMs ?? 180_000;
    this.#initialDelayMs = options.initialDelayMs ?? 500;
    this.#maxDelayMs = options.maxDelayMs ?? 5_000;
    this.#sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? console;
  }

  /** Postgres is not reachable yet (starting, restarting, or its DNS name not registered). */
  static isUnreachable(error: unknown): boolean {
    const e = error as { code?: unknown; message?: unknown; errors?: unknown[] } | null;
    if (!e || typeof e !== 'object') return false;
    const code = typeof e.code === 'string' ? e.code : '';
    // 57P01-3 shutdown / crash / cannot connect now, 08xxx connection exceptions, 53300 too many connections.
    if (/^(57P0[123]|08|53300)/.test(code) || TRANSIENT_NETWORK_CODES.has(code)) return true;
    if (Array.isArray(e.errors) && e.errors.length && e.errors.every(inner => StartupDatabaseWait.isUnreachable(inner))) return true;

    return typeof e.message === 'string' && /Connection terminated|connection.*(?:closed|ended)|timeout exceeded when trying to connect/i.test(e.message);
  }

  /** Run `probe` until it succeeds; retry only while Postgres is unreachable and the deadline has not passed. */
  async until<T>(label: string, probe: () => Promise<T>): Promise<T> {
    const startedAt = this.#now();
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await probe();
        if (attempt > 1) this.#log.log(`[${ this.#name }] Postgres reachable for ${ label } after ${ attempt } attempts`);

        return result;
      } catch (error) {
        if (!StartupDatabaseWait.isUnreachable(error)) throw error;
        const delay = Math.min(this.#initialDelayMs * 2 ** Math.min(attempt - 1, 10), this.#maxDelayMs);
        if (this.#now() - startedAt + delay > this.#deadlineMs) throw error;
        // First miss, then about once a minute: a slow Postgres start is one line, not a flood.
        if (attempt === 1 || attempt % 12 === 0) {
          this.#log.warn(`[${ this.#name }] waiting for Postgres during ${ label } (attempt ${ attempt }: ${ describe(error) }); retrying`);
        }
        await this.#sleep(delay);
      }
    }
  }
}

function describe(error: unknown): string {
  const e = error as { code?: string; message?: string } | null;

  return [e?.code, e?.message?.split('\n')[0]].filter(Boolean).join(' ') || 'unknown error';
}
