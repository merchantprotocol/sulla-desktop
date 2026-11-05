// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresConnection } from '@sulla/foundation/postgres';
import type { StrandedManagerCandidate } from '../Services/StrandedManagerDetector';

/** Persists and compare-and-sets the current stranded episode inside agent_jobs.tasks JSONB. */
export class StrandedEpisodeRepository {
  constructor(private readonly connection: Pick<PostgresConnection, 'select'>) {}

  async claim(candidate: StrandedManagerCandidate): Promise<boolean> {
    const episode = { stateKey: candidate.stateKey, detectedAt: candidate.detectedAt, reason: candidate.reason, alertedAt: candidate.detectedAt };
    const rows = await this.connection.select(`UPDATE agent_jobs SET tasks = jsonb_set(tasks, ARRAY[$2::text, 'stranded'], $3::jsonb, true)
      WHERE job_id = $1 AND COALESCE(tasks->$2->'stranded'->>'stateKey', '') <> $4 RETURNING job_id`,
    [candidate.managerJobId, candidate.managerTaskIndex, JSON.stringify(episode), candidate.stateKey]);
    return rows.length === 1;
  }

  async clear(jobId: string, taskIndex: number): Promise<boolean> {
    const rows = await this.connection.select(`UPDATE agent_jobs SET tasks = tasks #- ARRAY[$2::text, 'stranded']
      WHERE job_id = $1 AND tasks->$2 ? 'stranded' RETURNING job_id`, [jobId, taskIndex]);
    return rows.length === 1;
  }
}
