// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ServiceSecretSettingsStore } from '../../../app/Repositories/ServiceSecretRepository';
import type { ServiceSecretClock, ServiceSecretLogger } from '../../../app/Services/ServiceSecret/ServiceSecretProvider';

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

  async quarantineBootstrapFile(): Promise<string> {
    this.quarantined++;
    this.filePermanentFailure = undefined;
    this.file = null;

    return '/fake/sulla-settings-fallback.json.corrupt-1';
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
