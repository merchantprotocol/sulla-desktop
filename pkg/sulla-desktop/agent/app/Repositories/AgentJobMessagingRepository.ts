// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import * as crypto from 'crypto';
import { Repository } from '@sulla/foundation';

import { AgentJobMessage as AgentJobMessageModel } from '../Models/AgentJobMessage';
import type { AgentJobTaskTarget, AgentJobMessage, AgentJobCheckin, AgentJobTaskTelemetry } from '../../database/models/AgentJobMessagingModel';

export class AgentJobMessagingRepository extends Repository<AgentJobMessageModel> {
  protected readonly model = AgentJobMessageModel;
  private rowToTarget(row: any): AgentJobTaskTarget { return { jobId: row.job_id, taskIndex: Number(row.task_index), jobStatus: row.job_status, taskStatus: row.task_status, threadId: row.thread_id || undefined, parentChannel: row.parent_channel || undefined, parentThreadId: row.parent_thread_id || undefined }; }
  private rowToMessage(row: any): AgentJobMessage { return { id: row.id, jobId: row.job_id, taskIndex: Number(row.task_index), message: row.message, createdAt: new Date(row.created_at).getTime(), deliveredAt: row.delivered_at ? new Date(row.delivered_at).getTime() : undefined }; }
  private rowToCheckin(row: any): AgentJobCheckin { return { step: row.step, summary: row.summary, filesTouched: Array.isArray(row.files_touched) ? row.files_touched : [], blockers: Array.isArray(row.blockers) ? row.blockers : [], percent: row.percent == null ? undefined : Number(row.percent), createdAt: new Date(row.created_at).getTime() }; }

  async taskForThread(threadId: string): Promise<AgentJobTaskTarget | null> {
    const rows = await this.connection.select<any>(
      `SELECT j.job_id, j.status AS job_status, j.parent_channel, j.parent_thread_id,
              task.ordinality - 1 AS task_index,
              task.value->>'status' AS task_status,
              task.value->>'threadId' AS thread_id
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
              task.value->>'threadId' AS thread_id
         FROM agent_jobs j
         CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY AS task(value, ordinality)
        WHERE j.job_id = $1
        ORDER BY task.ordinality`,
      [jobId],
    );
    const targets = (rows ?? []).map(row => this.rowToTarget(row));

    return targets.filter(target =>
      (requestedTaskIndex === undefined || target.taskIndex === requestedTaskIndex) &&
      ['queued', 'running'].includes(target.taskStatus),
    );
  }

  async queueMessage(target: AgentJobTaskTarget, message: string): Promise<AgentJobMessage> {
    const id = crypto.randomUUID();
    const rows = await this.connection.select<any>(
      `INSERT INTO agent_job_messages (id, job_id, task_index, message)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, target.jobId, target.taskIndex, message],
    );

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
  }

  async appendCheckin(threadId: string, input: {
    step: string;
    summary: string;
    filesTouched?: string[];
    blockers?: string[];
    percent?: number;
  }): Promise<{ target: AgentJobTaskTarget; checkin: AgentJobCheckin } | null> {
    const target = await this.taskForThread(threadId);
    if (!target || target.jobStatus !== 'running' || !['queued', 'running'].includes(target.taskStatus)) return null;

    const rows = await this.connection.select<any>(
      `INSERT INTO agent_job_checkins
         (job_id, task_index, step, summary, files_touched, blockers, percent)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING *`,
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

    return { target, checkin: this.rowToCheckin(rows[0]) };
  }

  async telemetryForJob(jobId: string): Promise<Record<number, AgentJobTaskTelemetry>> {
    const [checkinRows, messageRows] = await Promise.all([
      this.connection.select<any>(
        `SELECT * FROM agent_job_checkins
          WHERE job_id = $1
          ORDER BY task_index, created_at DESC`,
        [jobId],
      ),
      this.connection.select<any>(
        `SELECT task_index, count(*)::int AS count
           FROM agent_job_messages
          WHERE job_id = $1 AND delivered_at IS NULL
          GROUP BY task_index`,
        [jobId],
      ),
    ]);
    const telemetry: Record<number, AgentJobTaskTelemetry> = {};
    const ensure = (index: number) => telemetry[index] ??= {
      latestCheckin: null,
      checkins: [],
      undeliveredMessages: 0,
    };

    for (const row of checkinRows ?? []) {
      const entry = ensure(Number(row.task_index));
      if (entry.checkins.length < 3) entry.checkins.push(this.rowToCheckin(row));
      entry.latestCheckin ??= this.rowToCheckin(row);
    }
    for (const row of messageRows ?? []) {
      ensure(Number(row.task_index)).undeliveredMessages = Number(row.count);
    }

    return telemetry;
  }

  /** Compact telemetry for a job list: one latest check-in and one message count per task. */
  async latestTelemetryForJobs(jobIds: string[]): Promise<Record<string, Record<number, AgentJobTaskTelemetry>>> {
    if (jobIds.length === 0) return {};
    const [checkinRows, messageRows] = await Promise.all([
      this.connection.select<any>(
        `SELECT DISTINCT ON (job_id, task_index) *
           FROM agent_job_checkins
          WHERE job_id = ANY($1::text[])
          ORDER BY job_id, task_index, created_at DESC`,
        [jobIds as unknown as string],
      ),
      this.connection.select<any>(
        `SELECT job_id, task_index, count(*)::int AS count
           FROM agent_job_messages
          WHERE job_id = ANY($1::text[]) AND delivered_at IS NULL
          GROUP BY job_id, task_index`,
        [jobIds as unknown as string],
      ),
    ]);
    const result: Record<string, Record<number, AgentJobTaskTelemetry>> = {};
    const ensure = (jobId: string, index: number) => {
      result[jobId] ??= {};
      return result[jobId][index] ??= { latestCheckin: null, checkins: [], undeliveredMessages: 0 };
    };
    for (const row of checkinRows ?? []) ensure(row.job_id, Number(row.task_index)).latestCheckin = this.rowToCheckin(row);
    for (const row of messageRows ?? []) ensure(row.job_id, Number(row.task_index)).undeliveredMessages = Number(row.count);
    return result;
  }
}
