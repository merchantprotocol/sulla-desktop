// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes } from 'crypto';

import { ServiceSecretProvider } from '@pkg/agent/app/Services/ServiceSecret/ServiceSecretProvider';

import { PostgresAuthReporter } from './PostgresAuthReporter';
import { PostgresHbaRestore } from './PostgresHbaRestore';
import { PostgresScramVerifier, ScramVerifierUnsupportedPasswordError } from './PostgresScramVerifier';
import type { PostgresProbeOutcome } from './Repositories/GuestPostgresAuthRepository';
import type {
  PostgresAuthConsumers, PostgresAuthLogger, PostgresAuthRepository, PostgresAuthSecretSource, PostgresAuthState, PostgresAuthTiming,
} from './PostgresAuthTypes';

export type {
  PostgresAuthConsumers, PostgresAuthLogger, PostgresAuthRepository, PostgresAuthSecretSource, PostgresAuthState, PostgresAuthTiming,
  PostgresAuthTrustReason,
} from './PostgresAuthTypes';

/**
 * Moves PostgreSQL from `trust` to `scram-sha-256` for network logins, so a
 * container on the `sulla_default` network (an agent) can no longer log in as
 * the superuser without the service secret. Local-socket logins stay `trust`:
 * Desktop reads the stored secret and rolls back through them.
 *
 * - converge(): make the role's password verifier match the service secret.
 *   Harmless under trust; call it after PostgreSQL is healthy and before any
 *   compose regeneration that hands consumers a new secret.
 * - apply(): converge, check every gate, then back up, write the managed hba,
 *   check its rules, reload and verify. Any failed check after the write rolls
 *   back. Whenever the result is trust, a managed file left on disk is restored
 *   and reloaded, so the next PostgreSQL start never loads an unverified file.
 *   Never terminates backends. Never throws; returns and logs the resulting state.
 *   A managed file that is loaded and valid but whose TCP probe keeps erroring
 *   (not refusing) stays scram, reported as unverified.
 * - verify(): the right secret logs in over TCP and a wrong one gets 28P01.
 * - rollback(): restore the pre-switch hba (or a trust file) and reload.
 *
 * The managed hba file is its own marker: it travels with the data volume.
 * The secret never goes to argv or to a log line.
 */
export class PostgresAuthHardening {
  static readonly MANAGED_HEADER = PostgresHbaRestore.MANAGED_HEADER;
  static readonly MANAGED_HBA = PostgresHbaRestore.MANAGED_HBA;
  /** Written by rollback when no unmanaged backup exists. */
  static readonly TRUST_HBA = PostgresHbaRestore.TRUST_HBA;

  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly verifyAttempts: number;
  private readonly verifyDelayMs: number;
  private readonly healthTimeoutMs: number;
  private readonly loadSettleMs: number;
  private readonly reporter: PostgresAuthReporter;
  private readonly hba: PostgresHbaRestore;

  constructor(
    private readonly repository: PostgresAuthRepository,
    private readonly secret: PostgresAuthSecretSource,
    private readonly consumers: PostgresAuthConsumers,
    private readonly logger: PostgresAuthLogger = console,
    private readonly wrongPassword: () => string = () => randomBytes(24).toString('base64url'),
    private readonly developmentPassword: string = ServiceSecretProvider.DEVELOPMENT_PASSWORD,
    timing: PostgresAuthTiming = {},
  ) {
    this.sleep = timing.sleep ?? PostgresAuthHardening.abortableSleep;
    this.verifyAttempts = Math.max(1, timing.verifyAttempts ?? 5);
    this.verifyDelayMs = timing.verifyDelayMs ?? 200;
    this.healthTimeoutMs = timing.healthTimeoutMs ?? 120_000;
    this.loadSettleMs = Math.max(1000, timing.loadSettleMs ?? 1100);
    this.reporter = new PostgresAuthReporter(logger);
    this.hba = new PostgresHbaRestore(repository, logger, this.reporter);
  }

  /** Sets the role password when its verifier does not match the secret. True when it matches afterwards. Never throws. */
  async converge(): Promise<boolean> {
    let secret = '';

    try {
      secret = await this.secret.value();

      return await this.convergeWith(secret);
    } catch (error) {
      this.logger.warn(`[PostgresAuth] role password not converged: ${ this.reporter.describe(error, secret) }`);

      return false;
    }
  }

  /** Switches network logins to scram when every gate passes; otherwise leaves (or puts back) trust. Never throws. */
  async apply(): Promise<PostgresAuthState> {
    let secret = '';

    try {
      secret = await this.secret.value();
    } catch (error) {
      return this.reporter.report({ kind: 'trust', reason: 'unavailable', detail: this.reporter.describe(error, secret) });
    }

    return this.reporter.report(await this.applyWith(secret));
  }

  /** True when the secret logs in over TCP and a wrong password is refused with 28P01. Never throws. */
  async verify(): Promise<boolean> {
    try {
      return await this.verifyWith(await this.secret.value());
    } catch {
      return false;
    }
  }

  /** Restores the pre-switch hba file (or a trust file when there is no usable backup) and reloads. True on success. */
  async rollback(reason: string): Promise<boolean> {
    return this.hba.restore(reason, true);
  }

  static isManaged(content: string): boolean {
    return PostgresHbaRestore.isManaged(content);
  }

  /** Decides, then makes the file on disk agree with a trust result. Never throws. */
  private async applyWith(secret: string): Promise<PostgresAuthState> {
    let state: PostgresAuthState;

    try {
      state = await this.decide(secret);
    } catch (error) {
      state = { kind: 'trust', reason: 'unavailable', detail: this.reporter.describe(error, secret) };
    }

    if (state.kind === 'trust') {
      await this.hba.restoreIfManaged(this.reporter.reasonText(state.reason));
    }

    return state;
  }

  private async decide(secret: string): Promise<PostgresAuthState> {
    if (secret === this.developmentPassword) {
      return { kind: 'trust', reason: 'legacy-development-secret' };
    }
    try {
      if (!await this.convergeWith(secret)) {
        return { kind: 'trust', reason: 'role-password-not-set' };
      }
    } catch (error) {
      return error instanceof ScramVerifierUnsupportedPasswordError
        ? { kind: 'trust', reason: 'unsupported-secret' }
        : { kind: 'trust', reason: 'role-password-not-set', detail: this.reporter.describe(error, secret) };
    }

    const path = await this.repository.hbaPath();
    const current = await this.repository.readHbaFile(path);

    // Already managed and live: nothing to do, and no deliberate wrong-password
    // login (FATAL log noise) on every boot. A managed file that is on disk but
    // not loaded (a switch interrupted before its reload) goes through the gates.
    if (current === PostgresAuthHardening.MANAGED_HBA) {
      const live = await this.managedAndLive(path, secret);

      if (live !== null) {
        return live;
      }
    }

    return await this.gate(secret) ?? this.switchTo(path, secret, PostgresAuthHardening.isManaged(current));
  }

  /**
   * scram when the managed file parses, is the one loaded, and the secret logs in
   * over TCP; null sends the install through the gates. A probe that keeps
   * erroring (a flaky docker exec, not a refusal) on a loaded, valid managed file
   * keeps scram as unverified instead of downgrading to trust.
   */
  private async managedAndLive(path: string, secret: string): Promise<PostgresAuthState | null> {
    if ((await this.ruleErrors()).length > 0 || !await this.repository.hbaFileLoaded(path)) {
      return null;
    }
    const probe = await this.probeRetryingErrors(secret);

    if (probe === 'ok') {
      return { kind: 'scram', changed: false };
    }

    return probe === 'error' ? { kind: 'scram', changed: false, unverified: true } : null;
  }

  /** probeTcp, retried while it ends in 'error' (up to verifyAttempts); a refusal is returned at once. */
  private async probeRetryingErrors(secret: string): Promise<PostgresProbeOutcome> {
    let outcome: PostgresProbeOutcome = 'error';

    for (let attempt = 1; attempt <= this.verifyAttempts; attempt++) {
      outcome = await this.repository.probeTcp(secret);
      if (outcome !== 'error') {
        return outcome;
      }
      if (attempt < this.verifyAttempts) {
        await this.sleep(this.verifyDelayMs);
      }
    }

    return outcome;
  }

  /** The first gate that fails, or null when the switch may go ahead. */
  private async gate(secret: string): Promise<PostgresAuthState | null> {
    const drifted = await this.consumers.driftedConsumers();

    if (drifted.length > 0) {
      return { kind: 'trust', reason: 'consumer-drift', detail: drifted.join(', ') };
    }
    if (!await this.consumers.accountsCurrent()) {
      return { kind: 'trust', reason: 'accounts-stale' };
    }
    const probe = await this.repository.probeTcp(secret);

    return probe === 'ok' ? null : { kind: 'trust', reason: 'probe-failed', detail: probe };
  }

  /** `startedManaged`: the managed file was already on disk, so it may be loaded; restores must then reload. */
  private async switchTo(path: string, secret: string, startedManaged: boolean): Promise<PostgresAuthState> {
    try {
      await this.repository.backupHbaOnce(path);
    } catch (error) {
      // Nothing was written yet: trust is untouched.
      return { kind: 'trust', reason: 'switch-failed', detail: this.reporter.describe(error, secret) };
    }
    try {
      await this.repository.writeHbaFile(path, PostgresAuthHardening.MANAGED_HBA);
    } catch (error) {
      // The write is atomic (temp file + rename); put trust back in case it landed anyway.
      await this.hba.restore('the managed hba file could not be written', startedManaged);

      return { kind: 'trust', reason: 'switch-failed', detail: this.reporter.describe(error, secret) };
    }

    const errors = await this.ruleErrors();

    if (errors.length > 0) {
      await this.hba.restore('the managed hba file has rule errors', startedManaged);

      return { kind: 'trust', reason: 'hba-rule-errors', detail: errors.join('; ') };
    }

    // pg_stat_file reports whole seconds and hbaFileLoaded() treats a same-second
    // write and load as "not loaded"; reload in a later second than the write so
    // the next boot recognises the live file and takes the fast path.
    await this.sleep(this.loadSettleMs);

    try {
      await this.repository.reload();
    } catch (error) {
      await this.rollback('the configuration reload failed');

      return { kind: 'trust', reason: 'switch-failed', detail: this.reporter.describe(error, secret) };
    }

    if (!await this.verifyAfterReload(secret)) {
      await this.rollback('the service secret could not authenticate, or a wrong password was accepted');

      return { kind: 'trust', reason: 'rolled-back', detail: 'verification failed' };
    }

    // Existing sessions stay authenticated (scram checks new connections only), so
    // no backend is terminated: consumers' session advisory locks must survive.
    try {
      await this.waitHealthyBounded();
    } catch (error) {
      const detail = this.reporter.describe(error, secret);

      await this.rollback(`a database consumer could not authenticate (${ detail })`);

      return { kind: 'trust', reason: 'rolled-back', detail };
    }

    return { kind: 'scram', changed: true };
  }

  private async convergeWith(secret: string): Promise<boolean> {
    const current = PostgresScramVerifier.parse(await this.repository.roleVerifier());

    if (current?.matches(secret)) {
      return true;
    }
    await this.repository.setRolePassword(secret);
    const updated = PostgresScramVerifier.parse(await this.repository.roleVerifier());

    if (!updated?.matches(secret)) {
      return false;
    }
    this.logger.log('[PostgresAuth] role password converged to the service secret');

    return true;
  }

  /** pg_reload_conf() only signals the postmaster; retry so a not-yet-applied reload is not a rollback. */
  private async verifyAfterReload(secret: string): Promise<boolean> {
    for (let attempt = 1; attempt <= this.verifyAttempts; attempt++) {
      if (await this.verifyWith(secret)) {
        return true;
      }
      if (attempt < this.verifyAttempts) {
        await this.sleep(this.verifyDelayMs);
      }
    }

    return false;
  }

  /** Races consumers.waitHealthy() against the bound; either way the timer is cleared and the checks are told to stop. */
  private async waitHealthyBounded(): Promise<void> {
    const seconds = Math.round(this.healthTimeoutMs / 1000);
    const stop = new AbortController();
    const timeout = this.sleep(this.healthTimeoutMs, stop.signal).then(() => {
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

  private async verifyWith(secret: string): Promise<boolean> {
    if (await this.repository.probeTcp(secret) !== 'ok') {
      return false;
    }
    let wrong = this.wrongPassword();

    if (wrong === secret) {
      wrong = `${ wrong }x`;
    }

    return await this.repository.probeTcp(wrong) === 'auth-failed';
  }

  /** Rule errors; a failed check counts as an error (never reload an unchecked file). */
  private async ruleErrors(): Promise<string[]> {
    try {
      return await this.repository.hbaRuleErrors();
    } catch (error) {
      return [`rule check failed: ${ this.reporter.describe(error, '') }`];
    }
  }
}
