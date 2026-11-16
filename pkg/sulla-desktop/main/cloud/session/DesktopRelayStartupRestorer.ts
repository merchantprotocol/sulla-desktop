// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface RelayStartupClient {
  start(): Promise<void>;
}

export interface RelayStartupReporter {
  failed(error: unknown): void;
  exhausted(error: unknown): void;
}

export interface RelayStartupRestorerOptions {
  retryMs?: number;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Retries a paired relay startup while local settings storage is still booting. */
export class DesktopRelayStartupRestorer {
  private readonly retryMs: number;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: RelayStartupClient,
    private readonly reporter: RelayStartupReporter,
    options: RelayStartupRestorerOptions = {},
  ) {
    this.retryMs = options.retryMs ?? 10_000;
    this.deadlineMs = options.deadlineMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async restore(): Promise<void> {
    const startedAt = this.now();
    for (;;) {
      try {
        await this.client.start();
        return;
      } catch (error) {
        if (this.now() - startedAt >= this.deadlineMs) {
          this.reporter.exhausted(error);
          return;
        }
        this.reporter.failed(error);
        await this.sleep(this.retryMs);
      }
    }
  }
}
