// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { DatabaseOutageState, type DatabaseUnavailableClassifier } from '@pkg/agent/database/DatabaseAvailability';

type Sleep = (ms: number) => Promise<void>;

export interface DatabaseReadGuardLogger {
  info(message: string): void;
}

export interface DatabaseReadGuardOptions {
  classifier:      Pick<DatabaseUnavailableClassifier, 'isUnavailable'>;
  /** Resolves once the database answers a trivial query; rejects while it is down. */
  probe:           () => Promise<void>;
  /** Tells renderers the database is back so they reload what they showed empty. */
  notifyAvailable: () => void;
  /** True while the app is quitting; no retries or recovery polling then. */
  isShuttingDown:  () => boolean;
  logger?:         DatabaseReadGuardLogger;
  sleep?:          Sleep;
  /** Waits between in-call retries. Its length is the retry count. */
  retryDelaysMs?:  readonly number[];
  /** First and maximum wait between recovery probes (doubling in between). */
  recoveryMinMs?:  number;
  recoveryMaxMs?:  number;
}

const defaultSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Guards renderer-facing read IPC handlers against the database being down.
 *
 * Postgres lives in the Sulla VM, so for the first minute of a cold boot and
 * whenever the VM restarts, list handlers used to reject with "the database
 * system is starting up" / ECONNREFUSED. Electron logged every rejection and
 * renderers crashed into "Uncaught (in promise)".
 *
 * A guarded read retries briefly with backoff. If the database is still not
 * reachable it returns the caller's "not ready" value, logs one line for the
 * whole outage, and polls until the database answers; then it broadcasts
 * `database:available` once so renderers reload. Any other error (bad SQL,
 * missing table, a bug) is rethrown untouched.
 */
export class DatabaseReadGuard {
  private readonly outage = new DatabaseOutageState();
  private readonly sleep: Sleep;
  private readonly retryDelaysMs: readonly number[];
  private readonly recoveryMinMs: number;
  private readonly recoveryMaxMs: number;
  private recovery: Promise<void> | null = null;

  constructor(private readonly options: DatabaseReadGuardOptions) {
    this.sleep = options.sleep ?? defaultSleep;
    this.retryDelaysMs = options.retryDelaysMs ?? [250, 750, 1500];
    this.recoveryMinMs = options.recoveryMinMs ?? 1_000;
    this.recoveryMaxMs = options.recoveryMaxMs ?? 10_000;
  }

  /** True between the first served "not ready" value and the database answering again. */
  get isDatabaseDown(): boolean {
    return this.outage.isDown;
  }

  async run<T>(channel: string, read: () => Promise<T>, notReady: T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await read();
        this.endOutage();

        return result;
      } catch (error) {
        if (!this.options.classifier.isUnavailable(error)) throw error;
        if (this.options.isShuttingDown() || attempt >= this.retryDelaysMs.length) {
          this.beginOutage(channel, error);

          return notReady;
        }
        await this.sleep(this.retryDelaysMs[attempt]);
      }
    }
  }

  /** Waits for the current recovery poll, if any. For tests and shutdown. */
  async settled(): Promise<void> {
    await this.recovery;
  }

  private beginOutage(channel: string, error: unknown): void {
    if (this.outage.markUnavailable()) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.logger?.info(`[DatabaseReadGuard] Database not reachable (${ reason }); ${ channel } and other lists return empty until it is back`);
    }
    if (!this.options.isShuttingDown()) this.recovery ??= this.pollUntilAvailable();
  }

  private endOutage(): void {
    const downForMs = this.outage.markAvailable();
    if (downForMs === null) return;
    this.options.logger?.info(`[DatabaseReadGuard] Database reachable again after ${ Math.round(downForMs / 1000) }s`);
    this.options.notifyAvailable();
  }

  private async pollUntilAvailable(): Promise<void> {
    try {
      let wait = this.recoveryMinMs;
      while (this.outage.isDown && !this.options.isShuttingDown()) {
        await this.sleep(wait);
        if (!this.outage.isDown || this.options.isShuttingDown()) return;
        try {
          await this.options.probe();
          this.endOutage();

          return;
        } catch {
          wait = Math.min(wait * 2, this.recoveryMaxMs);
        }
      }
    } finally {
      this.recovery = null;
    }
  }
}

let shared: DatabaseReadGuard | null = null;

/** Process-wide guard wired to the Sulla Postgres pool and all renderer windows. */
export function getDatabaseReadGuard(): DatabaseReadGuard {
  if (shared) return shared;

  // Required lazily so importing this module never opens a database pool.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { postgresClient } = require('@pkg/agent/database/PostgresClient') as typeof import('@pkg/agent/database/PostgresClient');

  shared = new DatabaseReadGuard({
    classifier:      postgresClient.unavailableClassifier,
    probe:           async() => { await postgresClient.queryWithResult('SELECT 1') },
    isShuttingDown:  () => postgresClient.isShuttingDown,
    logger:          { info: message => console.log(message) },
    notifyAvailable: () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { webContents } = require('electron') as typeof import('electron');
      for (const contents of webContents.getAllWebContents()) {
        try {
          if (!contents.isDestroyed()) contents.send('database:available');
        } catch { /* a closing window must not break the broadcast */ }
      }
    },
  });

  return shared;
}
