// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ComposePostgresAuthConsumers } from './PostgresAuthConsumers';
import type { DriftStatusSource, ServiceHealthWait } from './PostgresAuthConsumers';
import { PostgresAuthHardening } from './PostgresAuthHardening';
import type { PostgresAuthLogger, PostgresAuthSecretSource, PostgresAuthState } from './PostgresAuthHardening';
import { QuietGuestDockerStdin } from './QuietGuestDockerStdin';
import { GuestPostgresAuthRepository } from './Repositories/GuestPostgresAuthRepository';

/** The PostgresAuthHardening steps the boot and secret-change paths call. */
export type PostgresAuthSteps = Pick<PostgresAuthHardening, 'converge' | 'apply'>;

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
 */
export class PostgresAuthLifecycle {
  static readonly STATUS_KEY = 'postgresAuth';
  static readonly CHECKING = 'checking';

  private applied?: { generation: number, status: Promise<string> };

  constructor(
    private readonly hardening: PostgresAuthSteps,
    private readonly accounts: AccountsPasswordRefresher,
    private readonly logger: PostgresAuthLogger = console,
  ) {}

  /** Builds the guest-backed lifecycle: one quiet stdin Docker runner shared by the repository and the consumer checks. */
  static forGuest(options: GuestPostgresAuthOptions): PostgresAuthLifecycle {
    const logger = options.logger ?? console;
    const docker = new QuietGuestDockerStdin(options.binary, options.guestArgs);
    const consumers = new ComposePostgresAuthConsumers(docker, options.drift, options.accountsPasswordFile, options.waitServiceHealthy, logger);
    const hardening = new PostgresAuthHardening(new GuestPostgresAuthRepository(docker), options.secret, consumers, logger);

    return new PostgresAuthLifecycle(hardening, consumers, logger);
  }

  /** How a hardening result reads in the boot status. */
  static statusText(state: PostgresAuthState): string {
    return state.kind === 'scram' ? 'scram' : `trust (${ state.reason })`;
  }

  /** Never throws. */
  async afterPostgresHealthy(): Promise<boolean> {
    return this.hardening.converge().catch(() => false);
  }

  /**
   * Starts apply() without waiting for it (fire and track). The returned
   * promise settles when the result is recorded and never rejects; boot must
   * not await it. A repeat for the same generation reuses the first run.
   */
  afterFirstPass(generation: number, bootStatus: Map<string, string>): Promise<void> {
    const key = PostgresAuthLifecycle.STATUS_KEY;

    if (this.applied?.generation !== generation) {
      const status = this.hardening.apply()
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

  /** Converge, then regenerate (its errors propagate as before), then refresh Accounts. */
  async aroundSecretChange(regenerate: () => Promise<unknown>): Promise<void> {
    await this.afterPostgresHealthy();
    await regenerate();
    await this.accounts.refreshAccounts();
  }
}
