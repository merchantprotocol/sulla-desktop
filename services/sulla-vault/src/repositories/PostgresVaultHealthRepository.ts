// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from '../db.js';

/** The /healthz database probe. */
export class PostgresVaultHealthRepository {
  constructor(private readonly client: Queryable) {}

  /** Rejects with the driver error when Postgres is unreachable. */
  async ping(): Promise<void> {
    await this.client.query('SELECT 1');
  }
}
