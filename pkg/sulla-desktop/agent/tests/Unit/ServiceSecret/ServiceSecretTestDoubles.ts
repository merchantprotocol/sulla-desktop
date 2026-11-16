// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ServiceSecretSettingsStore } from '../../../app/Repositories/ServiceSecretRepository';
import type {
  ServiceSecretClock, ServiceSecretInstallState, ServiceSecretLogger,
} from '../../../app/Services/ServiceSecret/ServiceSecretProvider';

/**
 * In-memory stand-in for SullaSettingsModel's two stores: the pre-database
 * bootstrap file and PostgreSQL. Reads can be made to fail the way the real
 * stores do at boot (corrupt/mid-write file, unreachable database).
 */
export class FakeSettingsStores implements ServiceSecretSettingsStore {
  ready = false;
  /** null = no bootstrap file on disk. */
  file: Record<string, unknown> | null = {};
  database = new Map<string, unknown>();
  /** Fail the next N bootstrap-file reads with this error. */
  fileFailures: Error[] = [];
  /** Fail every bootstrap-file read with this error while set. */
  filePermanentFailure?: Error;
  databaseFailures: Error[] = [];
  readonly writes: Array<{ store: 'file' | 'database'; property: string; value: unknown }> = [];
  quarantined = 0;
  /** What a repair can still read out of the corrupt file (the real model salvages complete pairs). */
  salvageable: Record<string, unknown> = {};

  async getSetting(property: string, fallback: unknown = null): Promise<unknown> {
    const failure = this.databaseFailures.shift();

    if (failure) throw failure;

    return this.database.has(property) ? this.database.get(property) : fallback;
  }

  async setSetting(property: string, value: unknown): Promise<void> {
    if (this.ready) {
      this.database.set(property, value);
      this.writes.push({ store: 'database', property, value });

      return;
    }
    await this.writeBootstrapSetting(property, value);
  }

  async readBootstrapFile(): Promise<Record<string, unknown> | null> {
    if (this.filePermanentFailure) throw this.filePermanentFailure;
    const failure = this.fileFailures.shift();

    if (failure) throw failure;

    return this.file ? { ...this.file } : null;
  }

  async writeBootstrapSetting(property: string, value: unknown): Promise<void> {
    this.file = { ...(this.file ?? {}), [property]: value };
    this.writes.push({ store: 'file', property, value });
  }

  async repairBootstrapFile(): Promise<void> {
    this.quarantined++;
    this.filePermanentFailure = undefined;
    this.file = { ...this.salvageable };
  }
}

export function corruptFileError(): Error {
  const error = new Error('Settings bootstrap file is not valid JSON');

  error.name = 'SettingsBootstrapFileCorruptError';

  return error;
}

/** A clock whose sleeps advance time instantly. */
export class FakeClock implements ServiceSecretClock {
  current = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }
}

export class RecordingLogger implements ServiceSecretLogger {
  readonly lines: string[] = [];

  log(message: string): void {
    this.lines.push(message);
  }

  warn(message: string): void {
    this.lines.push(message);
  }
}

/** Deterministic, distinct secrets: secret-1, secret-2, … */
export class SequenceGenerator {
  calls = 0;

  generate(): string {
    this.calls++;

    return `generated-secret-${ this.calls }`;
  }
}

/**
 * The runtime's answers: is this a fresh install, and what does the settings
 * database store (read in the guest, without Desktop's database client).
 */
export class FakeInstallState implements ServiceSecretInstallState {
  fresh = false;
  readFailure?: Error;
  databaseReads = 0;

  constructor(private readonly stores: FakeSettingsStores) {}

  async isFresh(): Promise<boolean> {
    return this.fresh;
  }

  async readDatabaseSecret(): Promise<string | null> {
    this.databaseReads++;
    if (this.readFailure) throw this.readFailure;
    const value = this.stores.database.get('sullaServicePassword');

    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}
