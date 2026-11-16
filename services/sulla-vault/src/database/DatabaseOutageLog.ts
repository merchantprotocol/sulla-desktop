// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultDatabaseErrorClassifier } from './VaultDatabaseErrorClassifier.js';

/** Logs "database unavailable" at most once per 30s regardless of request volume. */
export class DatabaseOutageLog {
  private lastOutageLog = 0;

  constructor(
    private readonly errors: VaultDatabaseErrorClassifier,
    private readonly clock: () => number = () => Date.now(),
    private readonly logger: Pick<typeof console, 'warn'> = console,
  ) {}

  warn(error: unknown): void {
    const now = this.clock();
    if (now - this.lastOutageLog < 30_000) return;
    this.lastOutageLog = now;
    this.logger.warn(`sulla-vault: Postgres unavailable, requests return 503 until it recovers (${ this.errors.describe(error) })`);
  }
}
