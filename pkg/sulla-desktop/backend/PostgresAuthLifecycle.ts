// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ComposePostgresAuthConsumers } from './PostgresAuthConsumers';
import type { DriftStatusSource, ServiceHealthWait } from './PostgresAuthConsumers';
import { PostgresAuthHardening } from './PostgresAuthHardening';
import type { PostgresAuthLogger, PostgresAuthSecretSource, PostgresAuthState, PostgresAuthTrustReason } from './PostgresAuthHardening';
import { QuietGuestDockerStdin } from './QuietGuestDockerStdin';
import { GuestPostgresAuthRepository } from './Repositories/GuestPostgresAuthRepository';

/** The PostgresAuthHardening steps the boot and secret-change paths call. */
export type PostgresAuthSteps = Pick<PostgresAuthHardening, 'converge' | 'apply' | 'restoreTrust'>;

/** Restarts Accounts when its database password changed since it started; never throws. */
export interface AccountsPasswordRefresher {
  refreshAccounts(): Promise<boolean>;
}

export interface GuestPostgresAuthOptions {
  /** The `sulla-runtime` executable. */
  binary: string;
  /** Wraps a guest command into the binary's arguments (the backend's root `guestExecArgs`). */
  guestArgs: (command: string[]) => string[];
  drift: DriftStatusSource;
  waitServiceHealthy: ServiceHealthWait;
  /** Host path of the Accounts `database.password` value store. */
  accountsPasswordFile: string;
  secret: PostgresAuthSecretSource;
  logger?: PostgresAuthLogger;
}

/**
 * When Desktop runs each PostgreSQL auth step (the order is the point):
 *
 * - afterPostgresHealthy(): the role password follows the service secret
 *   before any consumer starts with it (harmless while hba is still trust).
 * - afterFirstPass(): once per services generation, after the first pass over
 *   the optional services, start switching network logins to scram (or keeping
 *   trust) in the background. Boot is not held: the boot status reads
 *   `postgresAuth=checking` at once and the result when it lands (logged as a
 *   `[Sulla] Boot services: postgresAuth=…` line). Only `scram` means the
 *   database refuses logins without the secret; anything else reads as
 *   `trust (<reason>)`, never as healthy.
 * - aroundSecretChange(): a new secret is converged on the role BEFORE compose
 *   is regenerated and consumers are recreated with it (under scram they would
 *   otherwise lose access), then Accounts is restarted if its password file
 *   changed (its secret is not in env, so the drift sweep never recreates it).
 *   Fail-safe: if the role did not converge, regeneration threw, or Accounts
 *   did not pick up the new password, trust is put back (postgresAuth reads
 *   `trust (<reason>)`); the next boot's apply switches again once all agree.
 *
 * Every step that writes the role password or the hba file runs on one chain
 * (one at a time, in call order), so a secret change never interleaves with an
 * apply. The boot converge waits for its turn at most `bootWaitMs`: the step
 * in flight converges to the latest secret before it finishes anyway.
 *
 * Late apply: afterFirstPass() is called once every optional service is active,
 * or at the last first-pass attempt (about two minutes of retries). With an
 * unhealthy optional service scram therefore lands late, and the switch can run
 * alongside the slow reconcile loop; a consumer recreated mid-switch fails its
 * fresh login and the switch rolls back to trust (fail-safe) until next boot.
 */
export class PostgresAuthLifecycle {
  static readonly STATUS_KEY = 'postgresAuth';
  static readonly CHECKING = 'checking';

  static readonly BOOT_WAIT_MS = 15_000;

  private applied?: { generation: number, status: Promise<string> };
  /** Tail of the chain every role/hba writer runs on. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The boot status map of the latest generation, so a secret change can report a fallback. */
  private bootStatus?: Map<string, string>;

  constructor(
    private readonly hardening: PostgresAuthSteps,
    private readonly accounts: AccountsPasswordRefresher,
    private readonly logger: PostgresAuthLogger = console,
    private readonly bootWaitMs = PostgresAuthLifecycle.BOOT_WAIT_MS,
  ) {}

  /** Builds the guest-backed lifecycle: a quiet stdin Docker runner for the repository and consumer checks, a shorter one for fresh logins. */
  static forGuest(options: GuestPostgresAuthOptions): PostgresAuthLifecycle {
    const logger = options.logger ?? console;
    const docker = new QuietGuestDockerStdin(options.binary, options.guestArgs);
    // Fresh logins get their own short bound (the script's connect timeout is 5 s),
    // so one stuck exec cannot eat the hardening's whole 120 s consumer budget.
    const loginDocker = new QuietGuestDockerStdin(options.binary, options.guestArgs, undefined, ComposePostgresAuthConsumers.FRESH_LOGIN_TIMEOUT_MS);
    const consumers = new ComposePostgresAuthConsumers(docker, options.drift, options.accountsPasswordFile, options.waitServiceHealthy, logger,
      undefined, undefined, undefined, undefined, loginDocker);
    const hardening = new PostgresAuthHardening(new GuestPostgresAuthRepository(docker), options.secret, consumers, logger);

    return new PostgresAuthLifecycle(hardening, consumers, logger);
  }

  /** How a hardening result reads in the boot status. */
  static statusText(state: PostgresAuthState): string {
    if (state.kind === 'scram') {
      return state.unverified ? 'scram (unverified)' : 'scram';
    }

    return `trust (${ state.reason })`;
  }

  /**
   * Converges the role password on the chain. Waits for its turn at most
   * `bootWaitMs` (false when it did not get it; the converge still runs in
   * order). Once its turn starts, waits for the converge itself to finish.
   * Never throws.
   */
  async afterPostgresHealthy(): Promise<boolean> {
    let began!: () => void;
    const started = new Promise<true>((resolve) => {
      began = () => resolve(true);
    });
    const converged = this.serial(() => {
      began();

      return this.hardening.converge().catch(() => false);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.bootWaitMs);
      timer.unref?.();
    });

    try {
      if (!await Promise.race([started, waited])) {
        this.logger.warn('[PostgresAuth] the role password converge is queued behind a running step; boot continues');

        return false;
      }
    } finally {
      clearTimeout(timer);
    }

    return converged;
  }

  /**
   * Starts apply() without waiting for it (fire and track). The returned
   * promise settles when the result is recorded and never rejects; boot must
   * not await it. A repeat for the same generation reuses the first run.
   */
  afterFirstPass(generation: number, bootStatus: Map<string, string>): Promise<void> {
    const key = PostgresAuthLifecycle.STATUS_KEY;

    this.bootStatus = bootStatus;
    if (this.applied?.generation !== generation) {
      const status = this.serial(() => this.hardening.apply())
        .then(state => PostgresAuthLifecycle.statusText(state))
        .catch(() => 'trust (unavailable)')
        .then((text) => {
          this.logger.log(`[Sulla] Boot services: ${ key }=${ text }`);

          return text;
        });

      this.applied = { generation, status };
    }
    const tracked = this.applied.status;

    if (!bootStatus.has(key)) {
      bootStatus.set(key, PostgresAuthLifecycle.CHECKING);
    }

    return tracked.then((text) => {
      bootStatus.set(key, text);
    });
  }

  /**
   * On the chain: converge, regenerate (its errors propagate as before), refresh
   * Accounts. Any of the three failing puts trust back before returning.
   */
  aroundSecretChange(regenerate: () => Promise<unknown>): Promise<void> {
    return this.serial(async() => {
      if (!await this.hardening.converge().catch(() => false)) {
        // Consumers are about to get a secret the role does not have.
        await this.fallBackToTrust('role-password-not-set');
      }
      try {
        await regenerate();
      } catch (error) {
        // Some consumers may still carry the old secret while the role has the new one.
        await this.fallBackToTrust('consumer-drift', 'compose regeneration failed');
        throw error;
      }
      if (!await this.accounts.refreshAccounts().catch(() => false)) {
        await this.fallBackToTrust('accounts-stale');
      }
    });
  }

  private async fallBackToTrust(reason: PostgresAuthTrustReason, detail?: string): Promise<void> {
    const state = await this.hardening.restoreTrust(reason, detail).catch((): PostgresAuthState => ({ kind: 'trust', reason }));
    const text = PostgresAuthLifecycle.statusText(state);

    this.bootStatus?.set(PostgresAuthLifecycle.STATUS_KEY, text);
    if (this.applied) {
      // A repeat afterFirstPass for this generation must not report the earlier scram again.
      this.applied = { generation: this.applied.generation, status: Promise.resolve(text) };
    }
    this.logger.log(`[Sulla] Boot services: ${ PostgresAuthLifecycle.STATUS_KEY }=${ text } (after a service secret change)`);
  }

  /** Runs `task` after every earlier step settled; one failing step never blocks the next. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);

    this.chain = run.catch(() => undefined);

    return run;
  }
}
