// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Where the service secret was read from. */
export type ServiceSecretStoreKind = 'database' | 'bootstrap-file';

/**
 * One read of the service secret. "absent" means the store answered and has
 * no value; "unreadable" means the store could not answer yet (file
 * mid-write or corrupt, fallback path not set, PostgreSQL unreachable).
 */
export type ServiceSecretRead =
  | { kind: 'found'; value: string; store: ServiceSecretStoreKind }
  | { kind: 'absent'; store: ServiceSecretStoreKind }
  | { kind: 'unreadable'; store: ServiceSecretStoreKind; reason: string; corrupt?: boolean };

/** The settings operations the repository needs (SullaSettingsModel satisfies it). */
export interface ServiceSecretSettingsStore {
  /** True once settings are served from PostgreSQL rather than the bootstrap file. */
  readonly ready: boolean;
  getSetting(property: string, fallback?: unknown): Promise<unknown>;
  setSetting(property: string, value: unknown, cast?: string): Promise<void>;
  /** The pre-database settings file; null when missing, throws when unreadable. */
  readBootstrapFile(): Promise<Record<string, unknown> | null>;
  writeBootstrapSetting(property: string, value: unknown): Promise<void>;
  /** Move a corrupt bootstrap file aside; returns where it went. */
  quarantineBootstrapFile(): Promise<string>;
}

export interface ServiceSecretRepositoryLogger {
  warn(message: string): void;
}

/**
 * Reads and writes the install's shared service secret (`sullaServicePassword`).
 *
 * Before PostgreSQL is up the bootstrap file is the only store; afterwards the
 * database is authoritative and the file is kept as a mirror so the next boot
 * reads the same value before the database starts.
 */
export class ServiceSecretRepository {
  static readonly PROPERTY = 'sullaServicePassword';

  constructor(
    private readonly settings: ServiceSecretSettingsStore,
    private readonly log: ServiceSecretRepositoryLogger = console,
  ) {}

  /** True once reads and writes go to PostgreSQL. */
  get databaseReady(): boolean {
    return this.settings.ready;
  }

  /** Read from whichever store is authoritative right now. */
  read(): Promise<ServiceSecretRead> {
    return this.settings.ready ? this.readDatabase() : this.readBootstrapFile();
  }

  async readDatabase(): Promise<ServiceSecretRead> {
    try {
      const value = await this.settings.getSetting(ServiceSecretRepository.PROPERTY, null);

      return ServiceSecretRepository.isSecret(value)
        ? { kind: 'found', value, store: 'database' }
        : { kind: 'absent', store: 'database' };
    } catch (error) {
      return { kind: 'unreadable', store: 'database', reason: ServiceSecretRepository.reasonOf(error) };
    }
  }

  async readBootstrapFile(): Promise<ServiceSecretRead> {
    try {
      const data = await this.settings.readBootstrapFile();
      const value = data?.[ServiceSecretRepository.PROPERTY];

      return ServiceSecretRepository.isSecret(value)
        ? { kind: 'found', value, store: 'bootstrap-file' }
        : { kind: 'absent', store: 'bootstrap-file' };
    } catch (error) {
      return {
        kind:    'unreadable',
        store:   'bootstrap-file',
        reason:  ServiceSecretRepository.reasonOf(error),
        corrupt: (error as Error | undefined)?.name === 'SettingsBootstrapFileCorruptError',
      };
    }
  }

  /** Move a persistently corrupt bootstrap file aside so it reads as missing. */
  async quarantineBootstrapFile(): Promise<void> {
    const movedTo = await this.settings.quarantineBootstrapFile();

    this.log.warn(`[ServiceSecret] Settings bootstrap file stayed corrupt; moved it aside to ${ movedTo }`);
  }

  /** Persist to the authoritative store and, once the database is up, mirror to the bootstrap file. */
  async save(value: string): Promise<void> {
    await this.settings.setSetting(ServiceSecretRepository.PROPERTY, value, 'string');
    if (this.settings.ready) await this.mirrorToBootstrapFile(value);
  }

  /** Write the database copy only (used to converge a value first read from the bootstrap file). */
  async saveToDatabase(value: string): Promise<void> {
    if (!this.settings.ready) throw new Error('Settings database is not ready');
    await this.settings.setSetting(ServiceSecretRepository.PROPERTY, value, 'string');
  }

  /** Best effort: keep the pre-database copy equal to the database value. */
  async mirrorToBootstrapFile(value: string): Promise<void> {
    try {
      const current = await this.settings.readBootstrapFile();

      if (current?.[ServiceSecretRepository.PROPERTY] === value) return;
      await this.settings.writeBootstrapSetting(ServiceSecretRepository.PROPERTY, value);
    } catch (error) {
      this.log.warn(`[ServiceSecret] Could not mirror the service secret to the bootstrap file: ${ ServiceSecretRepository.reasonOf(error) }`);
    }
  }

  private static isSecret(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
  }

  private static reasonOf(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).split('\n')[0];
  }
}
