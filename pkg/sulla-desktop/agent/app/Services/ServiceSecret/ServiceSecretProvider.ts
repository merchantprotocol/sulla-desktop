// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ServiceSecretRead, ServiceSecretRepository, ServiceSecretStoreKind } from '../../Repositories/ServiceSecretRepository';
import type { ServiceSecretGenerator } from './ServiceSecretGenerator';

/** Thrown instead of ever guessing a credential. Messages never contain secret values. */
export class ServiceSecretUnavailableError extends Error {
  constructor(message: string) {
    super(`Sulla service secret is unavailable: ${ message }`);
    this.name = 'ServiceSecretUnavailableError';
  }

  static afterWait(waitedMs: number, reason: string): ServiceSecretUnavailableError {
    return new ServiceSecretUnavailableError(`the settings store was not readable after ${ Math.round(waitedMs / 1000) }s (${ reason })`);
  }

  static notStored(detail: string): ServiceSecretUnavailableError {
    return new ServiceSecretUnavailableError(`${ detail }. This install already has a database, so a new secret would no longer match `
      + 'the data that derives from it (Files keys, backups, recipes). Restore "sullaServicePassword" in the settings file '
      + '(a damaged copy is kept beside it as *.corrupt-*) or in the settings database, then start Sulla again.');
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

/** What only the runtime knows: whether this install has a database yet, and how to open it. */
export interface ServiceSecretInstallState {
  /** True only when the install has never initialised its database (nothing can derive from a secret yet). */
  isFresh(): Promise<boolean>;
  /** Bring the settings database up so it can be read. Throws when it cannot. */
  openDatabase(): Promise<void>;
}

/** Called (not awaited) when the in-use secret changed, so compose can be regenerated. */
export type ServiceSecretChangeListener = (reason: string) => void | Promise<void>;

type SettledRead = Exclude<ServiceSecretRead, { kind: 'unreadable' }>;

/**
 * Single source of the install's shared service secret (PostgreSQL password,
 * Files local token and capability secret, service DATABASE_URLs).
 *
 * - Never returns a hardcoded credential as a fallback.
 * - A store that cannot answer yet is retried with bounded backoff, then fails.
 * - PostgreSQL is authoritative. A secret missing from the bootstrap file is
 *   generated only on a fresh install; otherwise the database is opened and
 *   its value adopted; nothing stored on an installed system is an error.
 * - When the database holds a different value than the one first read from
 *   the file, the database wins and change listeners are told.
 * - The historical development password is kept when it is what the install
 *   stored (data derives from it); it is never invented.
 * - The resolved value is cached for the process: a later compose
 *   regeneration never re-reads a store that may be mid-write or offline.
 */
export class ServiceSecretProvider {
  static readonly DEFAULT_POLICY: ServiceSecretWaitPolicy = { maxWaitMs: 60_000, baseDelayMs: 250, maxDelayMs: 4_000 };

  /** The public password older builds wrote when a settings read failed. */
  static readonly DEVELOPMENT_PASSWORD = 'sulla_dev_password';

  private resolved?: { value: string; store: ServiceSecretStoreKind };
  private resolving?: Promise<string>;
  private converging?: Promise<void>;
  private installState?: ServiceSecretInstallState;
  private readonly listeners = new Set<ServiceSecretChangeListener>();

  constructor(
    private readonly repository: ServiceSecretRepository,
    private readonly generator: ServiceSecretGenerator,
    private readonly clock: ServiceSecretClock = new SystemServiceSecretClock(),
    private readonly logger: ServiceSecretLogger = console,
    private readonly policy: ServiceSecretWaitPolicy = ServiceSecretProvider.DEFAULT_POLICY,
  ) {}

  /** Wired by the runtime once it can inspect and start the guest database. */
  useInstallState(state: ServiceSecretInstallState): void {
    this.installState = state;
  }

  onChange(listener: ServiceSecretChangeListener): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  async get(): Promise<string> {
    if (!this.resolved) {
      this.resolving ??= this.resolve().finally(() => {
        this.resolving = undefined;
      });
      await this.resolving;
    }
    await this.converge();

    return this.resolved!.value;
  }

  /** Once the database is up, make it agree with a value first read from the bootstrap file. */
  async converge(): Promise<void> {
    if (this.resolved?.store === 'bootstrap-file' && this.repository.databaseReady) await this.convergeDatabase();
  }

  private async resolve(): Promise<string> {
    const read = await this.settle(() => this.repository.read(), true);

    if (read.kind === 'absent') return this.resolveAbsent();
    if (read.store === 'bootstrap-file' && read.value === ServiceSecretProvider.DEVELOPMENT_PASSWORD) {
      return this.resolveDevelopmentPassword(read.value);
    }

    return this.adopt(read.value, read.store);
  }

  /** Nothing stored where we looked: generate only on a fresh install, else the database decides. */
  private async resolveAbsent(): Promise<string> {
    const state = await this.waitForInstallState();

    if (await state.isFresh()) return this.generate();
    const database = await this.consultDatabase(state);

    if (database.kind === 'found') return this.adopt(database.value, 'database');
    throw ServiceSecretUnavailableError.notStored('no service secret is stored in the settings file or the settings database');
  }

  /** The file holds the development password: the database's value wins when it differs. */
  private async resolveDevelopmentPassword(fileValue: string): Promise<string> {
    try {
      const database = await this.consultDatabase(await this.waitForInstallState());

      if (database.kind === 'found') {
        if (database.value !== fileValue) this.logger.warn('[ServiceSecret] The settings database holds a different service secret than the settings file; using the database value');

        return this.adopt(database.value, 'database');
      }
    } catch (error) {
      this.logger.warn(`[ServiceSecret] Could not consult the settings database (${ ServiceSecretProvider.reasonOf(error) }); using the stored value`);
    }

    return this.adopt(fileValue, 'bootstrap-file');
  }

  private async consultDatabase(state: ServiceSecretInstallState): Promise<SettledRead> {
    if (!this.repository.databaseReady) {
      try {
        await state.openDatabase();
      } catch (error) {
        throw new ServiceSecretUnavailableError(`the settings database could not be opened to read it (${ ServiceSecretProvider.reasonOf(error) })`);
      }
    }

    return this.settle(() => this.repository.readDatabase(), false);
  }

  /** Read until the store answers; a file still corrupt after the whole wait is repaired once. */
  private async settle(read: () => Promise<ServiceSecretRead>, repairCorrupt: boolean): Promise<SettledRead> {
    const startedAt = this.clock.now();
    let repaired = false;

    for (let attempt = 0; ; attempt++) {
      const result = await read();

      if (result.kind !== 'unreadable') return result;
      const waited = this.clock.now() - startedAt;

      if (waited >= this.policy.maxWaitMs) {
        if (repairCorrupt && result.corrupt && !repaired) {
          repaired = true;
          await this.repository.repairBootstrapFile();
          continue;
        }
        throw ServiceSecretUnavailableError.afterWait(waited, `${ result.store }: ${ result.reason }`);
      }
      const delay = Math.min(this.policy.baseDelayMs * 2 ** attempt, this.policy.maxDelayMs, this.policy.maxWaitMs - waited);

      if (attempt === 0) this.logger.warn(`[ServiceSecret] Settings ${ result.store } not readable yet (${ result.reason }); waiting`);
      await this.clock.sleep(Math.max(delay, 0));
    }
  }

  private async waitForInstallState(): Promise<ServiceSecretInstallState> {
    const startedAt = this.clock.now();

    while (!this.installState) {
      const waited = this.clock.now() - startedAt;

      if (waited >= this.policy.maxWaitMs) throw new ServiceSecretUnavailableError('the runtime never reported whether this install is new');
      await this.clock.sleep(Math.min(this.policy.maxDelayMs, this.policy.maxWaitMs - waited));
    }

    return this.installState;
  }

  private async adopt(value: string, store: ServiceSecretStoreKind): Promise<string> {
    this.resolved = { value, store };
    if (store === 'database') await this.repository.mirrorToBootstrapFile(value);
    if (value === ServiceSecretProvider.DEVELOPMENT_PASSWORD) {
      this.logger.warn('[ServiceSecret] This install\'s stored service secret is the historical development password; keeping it (rotation is a planned follow-up)');
    }

    return value;
  }

  private async generate(): Promise<string> {
    const value = this.generator.generate();

    await this.repository.save(value);
    this.resolved = { value, store: this.repository.databaseReady ? 'database' : 'bootstrap-file' };
    this.logger.log('[ServiceSecret] Generated the service secret for this new install');

    return value;
  }

  private convergeDatabase(): Promise<void> {
    this.converging ??= this.syncDatabase()
      .catch((error: unknown) => {
        this.logger.warn(`[ServiceSecret] Could not sync the service secret with the database yet: ${ ServiceSecretProvider.reasonOf(error) }`);
      })
      .finally(() => {
        this.converging = undefined;
      });

    return this.converging;
  }

  /** Write the database only when it has no value; a different stored value wins. */
  private async syncDatabase(): Promise<void> {
    const value = this.resolved!.value;
    const current = await this.repository.readDatabase();

    if (current.kind === 'unreadable') throw new Error(current.reason);
    if (current.kind === 'absent') {
      await this.repository.saveToDatabase(value);
      this.logger.log('[ServiceSecret] Stored the service secret from the settings file in the database');
    } else if (current.value !== value) {
      await this.adopt(current.value, 'database');
      this.logger.warn('[ServiceSecret] The settings database holds a different service secret than the settings file; switched to the database value');
      this.emitChange('database value differs from the settings file');

      return;
    }
    this.resolved = { value, store: 'database' };
  }

  private emitChange(reason: string): void {
    for (const listener of this.listeners) {
      Promise.resolve()
        .then(() => listener(reason))
        .catch((error: unknown) => this.logger.warn(`[ServiceSecret] Change listener failed: ${ ServiceSecretProvider.reasonOf(error) }`));
    }
  }

  private static reasonOf(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0];
  }
}
