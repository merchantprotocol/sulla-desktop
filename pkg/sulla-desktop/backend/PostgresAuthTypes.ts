// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { GuestPostgresAuthRepository } from './Repositories/GuestPostgresAuthRepository';

/** Why PostgreSQL still trusts network logins. */
export type PostgresAuthTrustReason =
  | 'legacy-development-secret'
  | 'unsupported-secret'
  | 'role-password-not-set'
  | 'consumer-drift'
  | 'accounts-stale'
  | 'probe-failed'
  | 'hba-rule-errors'
  | 'switch-failed'
  | 'rolled-back'
  | 'unavailable';

export type PostgresAuthState =
  | { kind: 'scram', changed: boolean }
  | { kind: 'trust', reason: PostgresAuthTrustReason, detail?: string };

/** What the caller knows about PostgreSQL's clients. Every method may throw; a throw keeps trust. */
export interface PostgresAuthConsumers {
  /** Running DB consumers whose compose hash label differs from the desired hash (empty when all match). */
  driftedConsumers(): Promise<string[]>;
  /** True when sulla_accounts started after its current database password file was written. */
  accountsCurrent(): Promise<boolean>;
  /**
   * Resolves when every DB consumer authenticates over a FRESH connection (not a
   * warm pooled one: sessions opened under trust stay logged in after the switch);
   * rejects naming the one that cannot. May be slow; apply() bounds it with
   * `healthTimeoutMs` and rolls back on timeout. apply() never terminates any
   * backend, so session-level advisory locks held by consumers survive.
   */
  waitHealthy(): Promise<void>;
}

export interface PostgresAuthSecretSource {
  value(): Promise<string>;
}

export interface PostgresAuthLogger {
  log(message: string): void;
  warn(message: string): void;
}

export type PostgresAuthRepository = Pick<GuestPostgresAuthRepository,
  'setRolePassword' | 'roleVerifier' | 'hbaPath' | 'readHbaFile' | 'writeHbaFile' | 'backupHbaOnce' | 'readHbaBackup'
  | 'hbaRuleErrors' | 'hbaFileLoaded' | 'reload' | 'probeTcp'>;

/** Timing knobs; specs inject `sleep` so nothing waits on a real clock. */
export interface PostgresAuthTiming {
  sleep?:           (ms: number) => Promise<void>;
  /** Verification attempts after the reload (pg_reload_conf is an async SIGHUP). */
  verifyAttempts?:  number;
  verifyDelayMs?:   number;
  /** Upper bound on consumers.waitHealthy() during a switch; a timeout rolls back. */
  healthTimeoutMs?: number;
}
