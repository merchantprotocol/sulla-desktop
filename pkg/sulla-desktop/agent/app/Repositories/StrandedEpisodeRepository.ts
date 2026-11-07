// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PostgresConnection } from '@sulla/foundation/postgres';
import type { StrandedManagerCandidate } from '../Services/StrandedManagerDetector';

export interface PendingStrandedEpisode extends StrandedManagerCandidate { attempts: number }

/** Durable outbox for stranded-manager episodes. Its PK is the episode CAS. */
export class StrandedEpisodeRepository {
  constructor(private readonly connection: Pick<PostgresConnection, 'select' | 'run'>) {}

  async insertPending(candidate: StrandedManagerCandidate): Promise<boolean> {
    const rows = await this.connection.select(`INSERT INTO agent_stranded_episodes
      (manager_job_id, manager_task_index, state_key, parent_channel, parent_thread_id, label, reason, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8 / 1000.0)) ON CONFLICT DO NOTHING RETURNING state_key`,
    [candidate.managerJobId, candidate.managerTaskIndex, candidate.stateKey, candidate.parentChannel,
      candidate.parentThreadId, candidate.label, candidate.reason, candidate.detectedAt]);
    return rows.length === 1;
  }


  async reconcile(managerRefs: Set<string>, candidates: StrandedManagerCandidate[]): Promise<void> {
    const active = new Map(candidates.map(candidate => [`${ candidate.managerJobId }#${ candidate.managerTaskIndex }`, candidate.stateKey]));
    for (const ref of managerRefs) {
      const split = ref.lastIndexOf('#');
      const jobId = ref.slice(0, split); const taskIndex = Number(ref.slice(split + 1)); const stateKey = active.get(ref);
      await this.connection.run(`DELETE FROM agent_stranded_episodes WHERE manager_job_id = $1 AND manager_task_index = $2 AND status = 'pending' AND $3::text IS NOT NULL AND state_key <> $3`,
        [jobId, taskIndex, stateKey ?? null]);
    }
  }

  async pending(stateKeys: string[]): Promise<PendingStrandedEpisode[]> {
    if (stateKeys.length === 0) return [];
    const rows = await this.connection.select(`SELECT * FROM agent_stranded_episodes WHERE status = 'pending' AND state_key = ANY($1::text[]) ORDER BY created_at, state_key`, [stateKeys as unknown as string]);
    return rows.map(row => ({ managerJobId: String(row.manager_job_id), managerTaskIndex: Number(row.manager_task_index),
      stateKey: String(row.state_key), parentChannel: String(row.parent_channel), parentThreadId: String(row.parent_thread_id),
      label: String(row.label), reason: String(row.reason), reasonKind: String(row.state_key).includes(':result-not-woken:') ? 'result-not-woken' : 'parked-without-live-children',
      detectedAt: Date.parse(String(row.created_at)), attempts: Number(row.attempts) }));
  }

  async markAttempt(stateKey: string): Promise<void> {
    await this.connection.run(`UPDATE agent_stranded_episodes SET attempts = attempts + 1 WHERE state_key = $1 AND status = 'pending'`, [stateKey]);
  }

  async markDelivered(stateKey: string): Promise<boolean> {
    const rows = await this.connection.select(`UPDATE agent_stranded_episodes SET status = 'delivered', delivered_at = now()
      WHERE state_key = $1 AND status = 'pending' RETURNING state_key`, [stateKey]);
    return rows.length === 1;
  }

  async deliveredForManagers(): Promise<Map<string, { stateKey: string; reason: string }>> {
    const rows = await this.connection.select(`SELECT DISTINCT ON (manager_job_id, manager_task_index) manager_job_id, manager_task_index, state_key, reason
      FROM agent_stranded_episodes WHERE status = 'delivered' ORDER BY manager_job_id, manager_task_index, delivered_at DESC`);
    return new Map(rows.map(row => [`${ row.manager_job_id }#${ row.manager_task_index }`, { stateKey: String(row.state_key), reason: String(row.reason) }]));
  }
}
