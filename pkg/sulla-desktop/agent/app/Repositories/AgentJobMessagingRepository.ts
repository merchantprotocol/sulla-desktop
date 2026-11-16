// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import * as crypto from 'crypto';
import { Repository } from '@sulla/foundation';

import { AgentJobMessage as AgentJobMessageModel } from '../Models/AgentJobMessage';
import type { AgentJobTaskTarget, AgentJobMessage, AgentJobCheckin, AgentJobCheckinReceipt, AgentJobTaskTelemetry } from '../../database/models/AgentJobMessagingModel';
import type { CustodyTransactionClient } from '../Services/JobCustodyTypes';

export class AgentJobMessagingRepository extends Repository<AgentJobMessageModel> {
  protected readonly model = AgentJobMessageModel;
  private static readonly TELEMETRY_TTL_MS = 5_000;
  private telemetryVersion = 0;
  private readonly telemetryReads = new Map<string, { expiresAt: number; version: number; value: Record<string, Record<number, AgentJobTaskTelemetry>> }>();
  private readonly telemetryInFlight = new Map<string, Promise<Record<string, Record<number, AgentJobTaskTelemetry>>>>();
  private telemetryClock: () => number = Date.now;
  /** Test seam for the telemetry cache clock. */
  setClock(clock: () => number): void { this.telemetryClock = clock; }
  /** Every check-in/message write goes through this repository; each one invalidates the telemetry cache. */
  private telemetryChanged(): void { this.telemetryVersion++; this.telemetryReads.clear(); }
  private rowToTarget(row: any): AgentJobTaskTarget { return { jobId: row.job_id, taskIndex: Number(row.task_index), jobStatus: row.job_status, taskStatus: row.task_status, threadId: row.thread_id || undefined, parentChannel: row.parent_channel || undefined, parentThreadId: row.parent_thread_id || undefined, label: row.label || undefined }; }
  private rowToMessage(row: any): AgentJobMessage { return { id: row.id, jobId: row.job_id, taskIndex: Number(row.task_index), message: row.message, createdAt: new Date(row.created_at).getTime(), deliveredAt: row.delivered_at ? new Date(row.delivered_at).getTime() : undefined }; }
  private rowToCheckin(row: any): AgentJobCheckin { return { step: row.step, summary: row.summary, filesTouched: Array.isArray(row.files_touched) ? row.files_touched : [], blockers: Array.isArray(row.blockers) ? row.blockers : [], percent: row.percent == null ? undefined : Number(row.percent), createdAt: new Date(row.created_at).getTime() }; }

  async taskForThread(threadId: string): Promise<AgentJobTaskTarget | null> {
    const rows = await this.connection.select<any>(
      `SELECT j.job_id, j.status AS job_status, j.parent_channel, j.parent_thread_id,
              task.ordinality - 1 AS task_index,
              task.value->>'status' AS task_status,
              task.value->>'threadId' AS thread_id,
              task.value->>'label' AS label
         FROM agent_jobs j
         CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY AS task(value, ordinality)
        WHERE task.value->>'threadId' = $1
        LIMIT 1`,
      [threadId],
    );

    return rows?.[0] ? this.rowToTarget(rows[0]) : null;
  }

  async targetsForJob(jobId: string, requestedTaskIndex?: number): Promise<AgentJobTaskTarget[]> {
    const rows = await this.connection.select<any>(
      `SELECT j.job_id, j.status AS job_status, j.parent_channel, j.parent_thread_id,
              task.ordinality - 1 AS task_index,
              task.value->>'status' AS task_status,
              task.value->>'threadId' AS thread_id,
              task.value->>'label' AS label
         FROM agent_jobs j
         CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY AS task(value, ordinality)
        WHERE j.job_id = $1
        ORDER BY task.ordinality`,
      [jobId],
    );
    const targets = (rows ?? []).map(row => this.rowToTarget(row));

    return targets.filter(target =>
      (requestedTaskIndex === undefined || target.taskIndex === requestedTaskIndex) &&
      ['queued', 'running', 'parked'].includes(target.taskStatus),
    );
  }

  /** Read active delivery targets while the caller holds the custody producer lock. */
  async openTargetsWithClient(client: CustodyTransactionClient, jobId: string, requestedTaskIndex?: number): Promise<AgentJobTaskTarget[]> {
    const rows = await client.query<any>(`SELECT j.job_id,j.status AS job_status,j.parent_channel,j.parent_thread_id,
        t.task_index,t.task_status,t.thread_id,t.label
      FROM agent_jobs j JOIN agent_job_tasks t ON t.job_id=j.job_id
      WHERE j.job_id=$1 AND ($2::int IS NULL OR t.task_index=$2)
        AND t.task_status IN ('queued','running','parked') ORDER BY t.task_index`, [jobId, requestedTaskIndex ?? null]);
    return rows.rows.map(row => this.rowToTarget(row));
  }

  /** Queue messages in the same transaction that checked the current custody owner. */
  async queueForTargetsWithClient(client: CustodyTransactionClient, jobId: string, targets: AgentJobTaskTarget[], messageForTarget: (target: AgentJobTaskTarget) => string): Promise<Array<{target:AgentJobTaskTarget;record:AgentJobMessage}>> {
    const queued: Array<{target:AgentJobTaskTarget;record:AgentJobMessage}> = [];
    for (const target of targets) {
      const id = crypto.randomUUID();
      const rows = await client.query<any>(`INSERT INTO agent_job_messages (id,job_id,task_index,message)
        VALUES ($1,$2,$3,$4) RETURNING *`, [id, jobId, target.taskIndex, messageForTarget(target)]);
      queued.push({target,record:this.rowToMessage(rows.rows[0])});
    }
    this.telemetryChanged();
    return queued;
  }

  async queueMessage(target: AgentJobTaskTarget, message: string): Promise<AgentJobMessage> {
    const id = crypto.randomUUID();
    const rows = await this.connection.select<any>(
      `INSERT INTO agent_job_messages (id, job_id, task_index, message)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, target.jobId, target.taskIndex, message],
    );
    this.telemetryChanged();

    return this.rowToMessage(rows[0]);
  }

  async pendingMessagesForThread(threadId: string): Promise<AgentJobMessage[]> {
    const rows = await this.connection.select<any>(
      `SELECT m.*
         FROM agent_job_messages m
         JOIN agent_jobs j ON j.job_id = m.job_id
         CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY AS task(value, ordinality)
        WHERE task.value->>'threadId' = $1
          AND m.task_index = task.ordinality - 1
          AND m.delivered_at IS NULL
        ORDER BY m.created_at ASC`,
      [threadId],
    );

    return (rows ?? []).map(row => this.rowToMessage(row));
  }

  async markMessagesDelivered(ids: string[], threadId: string): Promise<void> {
    if (ids.length === 0) return;
    await this.connection.run(
      `UPDATE agent_job_messages
          SET delivered_at = now(), delivery_thread_id = $2
        WHERE id = ANY($1::text[]) AND delivered_at IS NULL`,
      [ids as unknown as string, threadId],
    );
    this.telemetryChanged();
  }

  async appendCheckin(threadId: string, input: {
    step: string;
    summary: string;
    filesTouched?: string[];
    blockers?: string[];
    percent?: number;
  }): Promise<AgentJobCheckinReceipt | null> {
    const target = await this.taskForThread(threadId);
    // A parked manager's job row only flips back to 'running' when its own
    // run settles (completeJob) — it never un-parks mid-wake. Rejecting
    // 'parked' here would silently drop every check-in a rehydrated manager
    // sends before it finishes, so it is accepted the same as recordTaskReturn
    // and sendJobMessage already do.
    if (!target || !['running', 'parked'].includes(target.jobStatus) || !['queued', 'running', 'parked'].includes(target.taskStatus)) return null;

    const rows = await this.connection.select<any>(
      `WITH previous AS (
         SELECT blockers
           FROM agent_job_checkins
          WHERE job_id = $1 AND task_index = $2
          ORDER BY created_at DESC
          LIMIT 1
       ), inserted AS (
         INSERT INTO agent_job_checkins
         (job_id, task_index, step, summary, files_touched, blockers, percent)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING *
       )
       SELECT inserted.*,
              NOT EXISTS (SELECT 1 FROM previous WHERE previous.blockers = inserted.blockers) AS blockers_changed
         FROM inserted`,
      [
        target.jobId,
        target.taskIndex,
        input.step,
        input.summary,
        JSON.stringify(input.filesTouched ?? []),
        JSON.stringify(input.blockers ?? []),
        input.percent ?? null,
      ],
    );
    this.telemetryChanged();

    return { target, checkin: this.rowToCheckin(rows[0]), blockersChanged: Boolean(rows[0].blockers_changed) };
  }

  async telemetryForJob(jobId: string): Promise<Record<number, AgentJobTaskTelemetry>> {
    const [checkinRows, messageRows] = await Promise.all([
      this.connection.select<any>(
        // Only the 3 newest per task are ever kept below; do not drag a long-running job's whole history.
        `SELECT * FROM (
           SELECT c.*, row_number() OVER (PARTITION BY task_index ORDER BY created_at DESC) AS rn
             FROM agent_job_checkins c WHERE job_id = $1
         ) recent WHERE rn <= 3
          ORDER BY task_index, created_at DESC`,
        [jobId],
      ),
      this.connection.select<any>(
        `SELECT task_index,
                count(*) FILTER (WHERE delivered_at IS NULL)::int AS count,
                max(delivered_at) AS last_delivered_at
           FROM agent_job_messages
          WHERE job_id = $1
          GROUP BY task_index`,
        [jobId],
      ),
    ]);
    const telemetry: Record<number, AgentJobTaskTelemetry> = {};
    const ensure = (index: number) => telemetry[index] ??= {
      latestCheckin: null,
      checkins: [],
      undeliveredMessages: 0,
      lastMessageDeliveredAt: null,
    };

    for (const row of checkinRows ?? []) {
      const entry = ensure(Number(row.task_index));
      if (entry.checkins.length < 3) entry.checkins.push(this.rowToCheckin(row));
      entry.latestCheckin ??= this.rowToCheckin(row);
    }
    for (const row of messageRows ?? []) {
      const entry = ensure(Number(row.task_index));
      entry.undeliveredMessages = Number(row.count);
      entry.lastMessageDeliveredAt = row.last_delivered_at ? new Date(row.last_delivered_at).getTime() : null;
    }

    return telemetry;
  }

  /** Newest check-in time (ms) for one task: a single (job_id, task_index, created_at DESC) index probe. */
  async latestCheckinAt(jobId: string, taskIndex: number): Promise<number | null> {
    const rows = await this.connection.select<any>(
      `SELECT created_at FROM agent_job_checkins WHERE job_id = $1 AND task_index = $2 ORDER BY created_at DESC LIMIT 1`,
      [jobId, taskIndex],
    );
    return rows?.[0]?.created_at ? new Date(rows[0].created_at).getTime() : null;
  }

  /** Compact telemetry for a job list: one latest check-in and one message count per task. */
  async latestTelemetryForJobs(jobIds: string[]): Promise<Record<string, Record<number, AgentJobTaskTelemetry>>> {
    if (jobIds.length === 0) return {};
    // Polled by several surfaces: serve a recent identical read, and share one query between concurrent callers.
    const key = [...new Set(jobIds)].sort().join('\u0000');
    const cached = this.telemetryReads.get(key);
    if (cached && cached.expiresAt > this.telemetryClock() && cached.version === this.telemetryVersion) return cached.value;
    const running = this.telemetryInFlight.get(key);
    if (running) return running;
    const version = this.telemetryVersion;
    const read = this.queryLatestTelemetry(jobIds).then((value) => {
      if (version === this.telemetryVersion) {
        if (this.telemetryReads.size >= 64) this.telemetryReads.delete(this.telemetryReads.keys().next().value!);
        this.telemetryReads.set(key, { expiresAt: this.telemetryClock() + AgentJobMessagingRepository.TELEMETRY_TTL_MS, version, value });
      }
      return value;
    }).finally(() => { if (this.telemetryInFlight.get(key) === read) this.telemetryInFlight.delete(key); });
    this.telemetryInFlight.set(key, read);
    return read;
  }

  private async queryLatestTelemetry(jobIds: string[]): Promise<Record<string, Record<number, AgentJobTaskTelemetry>>> {
    const [checkinRows, messageRows] = await Promise.all([
      this.connection.select<any>(
        `SELECT DISTINCT ON (job_id, task_index) job_id, task_index, step, summary, files_touched, blockers, percent, created_at
           FROM agent_job_checkins
          WHERE job_id = ANY($1::text[])
          ORDER BY job_id, task_index, created_at DESC`,
        [jobIds as unknown as string],
      ),
      this.connection.select<any>(
        `SELECT job_id, task_index,
                count(*) FILTER (WHERE delivered_at IS NULL)::int AS count,
                max(delivered_at) AS last_delivered_at
           FROM agent_job_messages
          WHERE job_id = ANY($1::text[])
          GROUP BY job_id, task_index`,
        [jobIds as unknown as string],
      ),
    ]);
    const result: Record<string, Record<number, AgentJobTaskTelemetry>> = {};
    const ensure = (jobId: string, index: number) => {
      result[jobId] ??= {};
      return result[jobId][index] ??= { latestCheckin: null, checkins: [], undeliveredMessages: 0, lastMessageDeliveredAt: null };
    };
    for (const row of checkinRows ?? []) ensure(row.job_id, Number(row.task_index)).latestCheckin = this.rowToCheckin(row);
    for (const row of messageRows ?? []) {
      const entry = ensure(row.job_id, Number(row.task_index));
      entry.undeliveredMessages = Number(row.count);
      entry.lastMessageDeliveredAt = row.last_delivered_at ? new Date(row.last_delivered_at).getTime() : null;
    }
    return result;
  }
}
