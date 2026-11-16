// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultDatabaseErrorClassifier } from './VaultDatabaseErrorClassifier.js';

/** Retries an operation until Postgres is reachable, with capped exponential backoff. */
export class DatabaseReadiness {
  constructor(
    private readonly errors: VaultDatabaseErrorClassifier,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((done) => setTimeout(done, ms)),
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {}

  async untilReady<T>(label: string, operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (!this.errors.isTransient(error)) throw error;
        const delay = Math.min(500 * 2 ** Math.min(attempt - 1, 4), 5000);
        // First miss, then roughly once a minute: an outage is one line, not a flood.
        if (attempt === 1 || attempt % 12 === 0) {
          this.logger.warn(`sulla-vault: waiting for Postgres during ${ label } (attempt ${ attempt }, ${ this.errors.describe(error) }); retrying every ${ delay / 1000 }s`);
        }
        await this.sleep(delay);
      }
    }
  }
}
