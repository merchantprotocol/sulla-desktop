// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ServiceSecretRead, ServiceSecretRepository, ServiceSecretStoreKind } from '../../Repositories/ServiceSecretRepository';
import type { ServiceSecretGenerator } from './ServiceSecretGenerator';

/** Thrown when the settings store never became readable within the wait budget. */
export class ServiceSecretUnavailableError extends Error {
  constructor(waitedMs: number, reason: string) {
    super(`Sulla service secret is unavailable: the settings store was not readable after ${ Math.round(waitedMs / 1000) }s (${ reason })`);
    this.name = 'ServiceSecretUnavailableError';
  }
}

export interface ServiceSecretClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class SystemServiceSecretClock implements ServiceSecretClock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export interface ServiceSecretLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ServiceSecretWaitPolicy {
  /** Total time to wait for an unreadable store before failing. */
  maxWaitMs:   number;
  baseDelayMs: number;
  maxDelayMs:  number;
}

/**
 * Single source of the install's shared service secret (PostgreSQL password,
 * Files local token and capability secret, service DATABASE_URLs).
 *
 * - Never returns a hardcoded credential.
 * - A store that cannot answer yet is retried with bounded backoff; the final
 *   timeout throws ServiceSecretUnavailableError instead of guessing.
 * - Only a confirmed-absent value (or the retired public development
 *   password) generates a new secret, once; it is persisted before return.
 * - Concurrent callers share one in-flight resolution and every caller in the
 *   process gets the same value afterwards, so compose generation (before the
 *   database is up) and Desktop's later callers can never disagree.
 */
export class ServiceSecretProvider {
  static readonly DEFAULT_POLICY: ServiceSecretWaitPolicy = { maxWaitMs: 60_000, baseDelayMs: 250, maxDelayMs: 4_000 };

  /** The public development password older builds wrote when the setting read failed. */
  static readonly RETIRED_SECRETS: readonly string[] = ['sulla_dev_password'];

  private resolved?: { value: string; store: ServiceSecretStoreKind };
  private resolving?: Promise<string>;
  private converging?: Promise<void>;

  constructor(
    private readonly repository: ServiceSecretRepository,
    private readonly generator: ServiceSecretGenerator,
    private readonly clock: ServiceSecretClock = new SystemServiceSecretClock(),
    private readonly logger: ServiceSecretLogger = console,
    private readonly policy: ServiceSecretWaitPolicy = ServiceSecretProvider.DEFAULT_POLICY,
  ) {}

  async get(): Promise<string> {
    if (!this.resolved) {
      this.resolving ??= this.resolve().finally(() => {
        this.resolving = undefined;
      });
      await this.resolving;
    }
    const resolved = this.resolved!;

    if (resolved.store === 'bootstrap-file' && this.repository.databaseReady) await this.convergeDatabase();

    return resolved.value;
  }

  private async resolve(): Promise<string> {
    const startedAt = this.clock.now();
    let quarantined = false;

    for (let attempt = 0; ; attempt++) {
      const read = await this.repository.read();

      if (read.kind !== 'unreadable') return this.accept(read);

      const waited = this.clock.now() - startedAt;

      if (waited >= this.policy.maxWaitMs) {
        // Writes are atomic, so a file still corrupt after the whole wait is
        // not a write in progress: move it aside once, then it reads as missing.
        if (read.corrupt && !quarantined) {
          quarantined = true;
          await this.repository.quarantineBootstrapFile();
          continue;
        }
        throw new ServiceSecretUnavailableError(waited, `${ read.store }: ${ read.reason }`);
      }
      const delay = Math.min(this.policy.baseDelayMs * 2 ** attempt, this.policy.maxDelayMs, this.policy.maxWaitMs - waited);

      if (attempt === 0) this.logger.warn(`[ServiceSecret] Settings ${ read.store } not readable yet (${ read.reason }); waiting`);
      await this.clock.sleep(Math.max(delay, 0));
    }
  }

  private async accept(read: Exclude<ServiceSecretRead, { kind: 'unreadable' }>): Promise<string> {
    if (read.kind === 'found' && !ServiceSecretProvider.RETIRED_SECRETS.includes(read.value)) {
      this.resolved = { value: read.value, store: read.store };
      if (read.store === 'database') await this.repository.mirrorToBootstrapFile(read.value);

      return read.value;
    }
    const value = this.generator.generate();

    await this.repository.save(value);
    this.resolved = { value, store: read.store };
    this.logger.log(read.kind === 'found'
      ? `[ServiceSecret] Replaced the retired development service password in the ${ read.store }`
      : `[ServiceSecret] Generated the install service secret in the ${ read.store }`);

    return value;
  }

  /**
   * The value was first read before PostgreSQL was up; once it is, make the
   * database hold the same value so later readers of the setting agree with
   * the containers compose already started. Failures are retried on a later call.
   */
  private convergeDatabase(): Promise<void> {
    this.converging ??= this.syncDatabase()
      .then(() => {
        if (this.resolved) this.resolved = { ...this.resolved, store: 'database' };
      })
      .catch((error: unknown) => {
        this.logger.warn(`[ServiceSecret] Could not sync the service secret to the database yet: ${ (error instanceof Error ? error.message : String(error)).split('\n')[0] }`);
      })
      .finally(() => {
        this.converging = undefined;
      });

    return this.converging;
  }

  private async syncDatabase(): Promise<void> {
    const value = this.resolved!.value;
    const current = await this.repository.readDatabase();

    if (current.kind === 'unreadable') throw new Error(current.reason);
    if (current.kind === 'found' && current.value === value) return;
    await this.repository.saveToDatabase(value);
    this.logger.log('[ServiceSecret] Synced the service secret from the bootstrap file to the database');
  }
}
