// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes } from 'crypto';

import { ServiceSecretProvider } from '@pkg/agent/app/Services/ServiceSecret/ServiceSecretProvider';

import { PostgresScramVerifier, ScramVerifierUnsupportedPasswordError } from './PostgresScramVerifier';
import type {
  PostgresAuthConsumers, PostgresAuthLogger, PostgresAuthRepository, PostgresAuthSecretSource, PostgresAuthState, PostgresAuthTiming,
  PostgresAuthTrustReason,
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
 * - verify(): the right secret logs in over TCP and a wrong one gets 28P01.
 * - rollback(): restore the pre-switch hba (or a trust file) and reload.
 *
 * The managed hba file is its own marker: it travels with the data volume.
 * The secret never goes to argv or to a log line.
 */
export class PostgresAuthHardening {
  static readonly MANAGED_HEADER = '# managed-by: sulla-desktop postgres-auth v1';
  static readonly MANAGED_HBA = `${ PostgresAuthHardening.MANAGED_HEADER }\nlocal all all trust\nhost all all all scram-sha-256\n`;
  /** Written by rollback when no unmanaged backup exists. */
  static readonly TRUST_HBA = 'local all all trust\nhost all all all trust\n';

  private static readonly REASON_TEXT: Record<PostgresAuthTrustReason, string> = {
    'legacy-development-secret': 'legacy development secret; rotation pending',
    'unsupported-secret':        'service secret cannot be turned into a SCRAM verifier',
    'role-password-not-set':     'role password could not be set',
    'consumer-drift':            'a database consumer still runs an outdated configuration',
    'accounts-stale':            'accounts has not picked up the current database password',
    'probe-failed':              'the service secret did not log in over TCP',
    'hba-rule-errors':           'the managed hba file has rule errors',
    'switch-failed':             'the hba switch did not complete',
    'rolled-back':               'rolled back after verification failed',
    unavailable:                 'PostgreSQL could not be inspected',
  };

  private readonly sleep: (ms: number) => Promise<void>;
  private readonly verifyAttempts: number;
  private readonly verifyDelayMs: number;
  private readonly healthTimeoutMs: number;

  constructor(
    private readonly repository: PostgresAuthRepository,
    private readonly secret: PostgresAuthSecretSource,
    private readonly consumers: PostgresAuthConsumers,
    private readonly logger: PostgresAuthLogger = console,
    private readonly wrongPassword: () => string = () => randomBytes(24).toString('base64url'),
    private readonly developmentPassword: string = ServiceSecretProvider.DEVELOPMENT_PASSWORD,
    timing: PostgresAuthTiming = {},
  ) {
    this.sleep = timing.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms).unref?.()));
    this.verifyAttempts = Math.max(1, timing.verifyAttempts ?? 5);
    this.verifyDelayMs = timing.verifyDelayMs ?? 200;
    this.healthTimeoutMs = timing.healthTimeoutMs ?? 120_000;
  }

  /** Sets the role password when its verifier does not match the secret. True when it matches afterwards. Never throws. */
  async converge(): Promise<boolean> {
    let secret = '';

    try {
      secret = await this.secret.value();

      return await this.convergeWith(secret);
    } catch (error) {
      this.logger.warn(`[PostgresAuth] role password not converged: ${ this.describe(error, secret) }`);

      return false;
    }
  }

  /** Switches network logins to scram when every gate passes; otherwise leaves (or puts back) trust. Never throws. */
  async apply(): Promise<PostgresAuthState> {
    let secret = '';

    try {
      secret = await this.secret.value();
    } catch (error) {
      return this.report({ kind: 'trust', reason: 'unavailable', detail: this.describe(error, secret) });
    }

    return this.report(await this.applyWith(secret));
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
    return this.restore(reason, true);
  }

  /**
   * Puts the pre-switch hba file back. `reload` is false only when the managed
   * file cannot have been loaded (a fresh switch failed before its reload): the
   * running rules are still the old ones, so restoring the file is enough.
   */
  private async restore(reason: string, reload: boolean): Promise<boolean> {
    try {
      const path = await this.repository.hbaPath();
      const restore = await this.restoreContent(path);

      if (restore !== null) {
        await this.repository.writeHbaFile(path, restore);
      }
      if (reload) {
        await this.repository.reload();
      }
      this.logger.warn(`[PostgresAuth] rolled back: ${ reason }`);

      return true;
    } catch (error) {
      this.logger.warn(`[PostgresAuth] rollback failed (${ reason }): ${ this.describe(error, '') }`);

      return false;
    }
  }

  /**
   * What rollback writes: the unmanaged backup; else a trust file when the
   * current file is managed; else null (an unmanaged file is left as it is).
   */
  private async restoreContent(path: string): Promise<string | null> {
    const backup = await this.repository.readHbaBackup(path);

    if (backup !== null && !PostgresAuthHardening.isManaged(backup)) {
      return backup;
    }

    return PostgresAuthHardening.isManaged(await this.repository.readHbaFile(path)) ? PostgresAuthHardening.TRUST_HBA : null;
  }

  static isManaged(content: string): boolean {
    return content.split('\n', 1)[0].trim() === PostgresAuthHardening.MANAGED_HEADER;
  }

  /** Decides, then makes the file on disk agree with a trust result. Never throws. */
  private async applyWith(secret: string): Promise<PostgresAuthState> {
    let state: PostgresAuthState;

    try {
      state = await this.decide(secret);
    } catch (error) {
      state = { kind: 'trust', reason: 'unavailable', detail: this.describe(error, secret) };
    }

    if (state.kind === 'trust') {
      await this.restoreIfManaged(state.reason);
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
        : { kind: 'trust', reason: 'role-password-not-set', detail: this.describe(error, secret) };
    }

    const path = await this.repository.hbaPath();
    const current = await this.repository.readHbaFile(path);

    // Already managed and live: nothing to do, and no deliberate wrong-password
    // login (FATAL log noise) on every boot. A managed file that is on disk but
    // not loaded (a switch interrupted before its reload) goes through the gates.
    if (current === PostgresAuthHardening.MANAGED_HBA && await this.managedAndLive(path, secret)) {
      return { kind: 'scram', changed: false };
    }

    return await this.gate(secret) ?? this.switchTo(path, secret, PostgresAuthHardening.isManaged(current));
  }

  /** The managed file parses, is the one loaded, and the secret logs in over TCP. */
  private async managedAndLive(path: string, secret: string): Promise<boolean> {
    return (await this.ruleErrors()).length === 0
      && await this.repository.hbaFileLoaded(path)
      && await this.repository.probeTcp(secret) === 'ok';
  }

  /** Trust was decided: a managed file must not stay on disk (or loaded). Never throws. */
  private async restoreIfManaged(reason: PostgresAuthTrustReason): Promise<void> {
    let managed: boolean;

    try {
      managed = PostgresAuthHardening.isManaged(await this.repository.readHbaFile(await this.repository.hbaPath()));
    } catch (error) {
      this.logger.warn(`[PostgresAuth] could not check the hba file after keeping trust: ${ this.describe(error, '') }`);

      return;
    }
    if (managed) {
      await this.restore(PostgresAuthHardening.REASON_TEXT[reason], true);
    }
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
      return { kind: 'trust', reason: 'switch-failed', detail: this.describe(error, secret) };
    }
    try {
      await this.repository.writeHbaFile(path, PostgresAuthHardening.MANAGED_HBA);
    } catch (error) {
      // The write is atomic (temp file + rename); put trust back in case it landed anyway.
      await this.restore('the managed hba file could not be written', startedManaged);

      return { kind: 'trust', reason: 'switch-failed', detail: this.describe(error, secret) };
    }

    const errors = await this.ruleErrors();

    if (errors.length > 0) {
      await this.restore('the managed hba file has rule errors', startedManaged);

      return { kind: 'trust', reason: 'hba-rule-errors', detail: errors.join('; ') };
    }

    try {
      await this.repository.reload();
    } catch (error) {
      await this.rollback('the configuration reload failed');

      return { kind: 'trust', reason: 'switch-failed', detail: this.describe(error, secret) };
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
      const detail = this.describe(error, secret);

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

  private async waitHealthyBounded(): Promise<void> {
    const seconds = Math.round(this.healthTimeoutMs / 1000);
    const timeout = this.sleep(this.healthTimeoutMs).then(() => {
      throw new Error(`database consumers were not healthy within ${ seconds }s`);
    });

    await Promise.race([this.consumers.waitHealthy(), timeout]);
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
      return [`rule check failed: ${ this.describe(error, '') }`];
    }
  }

  private report(state: PostgresAuthState): PostgresAuthState {
    if (state.kind === 'scram') {
      this.logger.log(`[PostgresAuth] state=scram${ state.changed ? ' (switched from trust)' : '' }`);
    } else {
      const detail = state.detail ? `: ${ state.detail }` : '';
      const line = `[PostgresAuth] state=trust (${ PostgresAuthHardening.REASON_TEXT[state.reason] }${ detail })`;

      if (state.reason === 'legacy-development-secret') {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }
    }

    return state;
  }

  /** An error's first line with the secret masked out (defence in depth; no caller should carry it). */
  private describe(error: unknown, secret: string): string {
    const text = (error instanceof Error ? error.message : String(error)).split('\n')[0];

    return secret ? text.split(secret).join('[redacted]') : text;
  }
}
