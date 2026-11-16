// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PostgresAuthConsumers, PostgresAuthRepository } from './PostgresAuthTypes';
import type { PostgresProbeOutcome } from './Repositories/GuestPostgresAuthRepository';

/** Resolved timing for the probes (PostgresAuthHardening fills the defaults). */
export interface PostgresAuthProbeTiming {
  sleep:           (ms: number, signal?: AbortSignal) => Promise<void>;
  verifyAttempts:  number;
  verifyDelayMs:   number;
  healthTimeoutMs: number;
}

/**
 * The login checks PostgresAuthHardening runs around a switch: TCP probes with
 * the secret and a wrong password, retried because pg_reload_conf() is an async
 * SIGHUP, and the bounded wait for every consumer's fresh login.
 */
export class PostgresAuthProbes {
  constructor(
    private readonly repository: Pick<PostgresAuthRepository, 'probeTcp'>,
    private readonly consumers: Pick<PostgresAuthConsumers, 'waitHealthy'>,
    private readonly wrongPassword: () => string,
    private readonly timing: PostgresAuthProbeTiming,
  ) {}

  /** True when the secret logs in over TCP and a wrong password is refused with 28P01. */
  async verify(secret: string): Promise<boolean> {
    if (await this.repository.probeTcp(secret) !== 'ok') {
      return false;
    }
    let wrong = this.wrongPassword();

    if (wrong === secret) {
      wrong = `${ wrong }x`;
    }

    return await this.repository.probeTcp(wrong) === 'auth-failed';
  }

  /** verify(), retried so a not-yet-applied reload is not a rollback. */
  async verifyAfterReload(secret: string): Promise<boolean> {
    for (let attempt = 1; attempt <= this.timing.verifyAttempts; attempt++) {
      if (await this.verify(secret)) {
        return true;
      }
      if (attempt < this.timing.verifyAttempts) {
        await this.timing.sleep(this.timing.verifyDelayMs);
      }
    }

    return false;
  }

  /** probeTcp, retried while it ends in 'error' (up to verifyAttempts); a refusal is returned at once. */
  async probeRetryingErrors(secret: string): Promise<PostgresProbeOutcome> {
    let outcome: PostgresProbeOutcome = 'error';

    for (let attempt = 1; attempt <= this.timing.verifyAttempts; attempt++) {
      outcome = await this.repository.probeTcp(secret);
      if (outcome !== 'error') {
        return outcome;
      }
      if (attempt < this.timing.verifyAttempts) {
        await this.timing.sleep(this.timing.verifyDelayMs);
      }
    }

    return outcome;
  }

  /** Races consumers.waitHealthy() against the bound; either way the timer is cleared and the checks are told to stop. */
  async waitHealthyBounded(): Promise<void> {
    const seconds = Math.round(this.timing.healthTimeoutMs / 1000);
    const stop = new AbortController();
    const timeout = this.timing.sleep(this.timing.healthTimeoutMs, stop.signal).then(() => {
      if (!stop.signal.aborted) {
        throw new Error(`database consumers were not healthy within ${ seconds }s`);
      }
    });

    try {
      await Promise.race([this.consumers.waitHealthy(stop.signal), timeout]);
    } finally {
      stop.abort();
    }
  }

  /** setTimeout-based sleep that clears its timer and resolves early when `signal` aborts. */
  static abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();

        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);

      timer.unref?.();
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
