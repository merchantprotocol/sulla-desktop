// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/**
 * Answers /healthz's "can this service still reach Postgres?" cheaply.
 *
 * A pool with callers queued for a connection is busy, not down: reporting that as
 * unhealthy would get a working service restarted mid-load, so it counts as reachable.
 * Otherwise one `SELECT 1` must answer within the timeout. The pool reconnects on its
 * own, so the probe recovers as soon as Postgres does.
 */
export class DatabaseHealthRepository {
  constructor(
    private readonly db: Pick<pg.Pool, 'query' | 'waitingCount'>,
    private readonly timeoutMs = 2_000,
  ) {}

  async reachable(): Promise<boolean> {
    if (this.db.waitingCount > 0) return true;
    let timer: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        this.db.query('SELECT 1'),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('database probe timed out')), this.timeoutMs) }),
      ]);

      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
