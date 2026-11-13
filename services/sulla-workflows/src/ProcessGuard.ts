// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Keeps a service container self-healing from the inside.
 *
 * - A crash (uncaught exception, unhandled rejection, or a dependency the service cannot
 *   live without) ends the process with a non-zero code, so Docker's `unless-stopped`
 *   restart policy brings it back clean instead of leaving a half-working process.
 * - SIGTERM/SIGINT run the service's own shutdown once, and a deadline makes sure the
 *   process always exits even when a dependency (Redis, Postgres) is already gone.
 *
 * Each service keeps its own copy because every service image builds from its own folder.
 */
export interface ProcessGuardOptions {
  /** Log prefix, e.g. sulla-tools. */
  name: string;
  /** How long a graceful shutdown may take before the process is forced out. */
  shutdownTimeoutMs?: number;
  /** Injectable for tests. */
  host?: Pick<NodeJS.Process, 'on' | 'once' | 'exit'>;
  log?: Pick<Console, 'error' | 'warn'>;
}

export class ProcessGuard {
  readonly #name: string;
  readonly #shutdownTimeoutMs: number;
  readonly #host: Pick<NodeJS.Process, 'on' | 'once' | 'exit'>;
  readonly #log: Pick<Console, 'error' | 'warn'>;
  #exiting = false;

  constructor(options: ProcessGuardOptions) {
    this.#name = options.name;
    // Docker waits 10 s after SIGTERM before SIGKILL; finish inside that.
    this.#shutdownTimeoutMs = options.shutdownTimeoutMs ?? 8_000;
    this.#host = options.host ?? process;
    this.#log = options.log ?? console;
  }

  /** Exit non-zero on any crash so Docker restarts the container. */
  catchCrashes(): this {
    this.#host.on('uncaughtException', error => this.fatal('uncaught exception', error));
    this.#host.on('unhandledRejection', error => this.fatal('unhandled rejection', error));

    return this;
  }

  /** Run `shutdown` once on SIGTERM/SIGINT and always exit, within the deadline. */
  handleSignals(shutdown: () => Promise<void> | void): this {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      this.#host.once(signal, () => { void this.shutdown(signal, shutdown) });
    }

    return this;
  }

  /** The service cannot continue (a lost dependency it cannot recover): log once and exit 1. */
  fatal(reason: string, error?: unknown): void {
    if (this.#exiting) return;
    this.#exiting = true;
    this.#log.error(`[${ this.#name }] fatal: ${ reason }; exiting so the container restarts`, error ?? '');
    this.#host.exit(1);
  }

  private async shutdown(signal: string, shutdown: () => Promise<void> | void): Promise<void> {
    if (this.#exiting) return;
    this.#exiting = true;
    const deadline = setTimeout(() => {
      this.#log.error(`[${ this.#name }] shutdown after ${ signal } did not finish in ${ this.#shutdownTimeoutMs } ms; forcing exit`);
      this.#host.exit(1);
    }, this.#shutdownTimeoutMs);

    try {
      await shutdown();
      clearTimeout(deadline);
      this.#host.exit(0);
    } catch (error) {
      clearTimeout(deadline);
      this.#log.error(`[${ this.#name }] shutdown after ${ signal } failed:`, error);
      this.#host.exit(1);
    }
  }
}
