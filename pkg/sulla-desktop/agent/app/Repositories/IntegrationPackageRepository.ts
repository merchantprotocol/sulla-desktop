// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PostgresClient } from '../../database/PostgresClient';

/** Reads the `integration_packages` table. */
export class IntegrationPackageRepository {
  constructor(private readonly client: Pick<PostgresClient, 'query'>) {}

  /** Distinct installed integration package ids, sorted by id. */
  async listDistinctIds(): Promise<string[]> {
    const rows = await this.client.query('SELECT DISTINCT id FROM integration_packages ORDER BY id');

    return rows.map((row: any) => String(row.id));
  }
}
