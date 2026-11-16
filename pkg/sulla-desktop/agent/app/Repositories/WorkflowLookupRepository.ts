// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresClient } from '../../database/PostgresClient';

/** Looks up workflow rows by id or case-insensitive name for set_workflow_status. */
export class WorkflowLookupRepository {
  constructor(private readonly client: Pick<PostgresClient, 'queryAll'>) {}

  async findById(id: string): Promise<any[]> {
    return this.client.queryAll(`SELECT id, name, status, enabled, system FROM workflows WHERE id = $1`, [id]);
  }

  async findByName(name: string | undefined): Promise<any[]> {
    return this.client.queryAll(`SELECT id, name, status, enabled, system FROM workflows WHERE LOWER(name) = LOWER($1)`, [name]);
  }
}
