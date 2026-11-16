// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PoolClient } from 'pg';

export interface ArtifactCustodyRow {
  id:         string;
  taskId:     string;
  transition: string;
  workKind:   string;
  custody:    unknown;
  actor:      string;
}

/** Immutable custody audit rows (`work_task_artifact_custody`), written inside the caller's transaction. */
export class ArtifactCustodyRepository {
  async insertWithClient(client: Pick<PoolClient, 'query'>, row: ArtifactCustodyRow): Promise<void> {
    await client.query(`
      INSERT INTO work_task_artifact_custody
        (id, task_id, transition, work_kind, custody, created_by)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `, [row.id, row.taskId, row.transition, row.workKind, JSON.stringify(row.custody), row.actor]);
  }
}
