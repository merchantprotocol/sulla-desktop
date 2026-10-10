import * as crypto from 'crypto';

import { postgresClient } from '../PostgresClient';

export interface AgentJobTaskTarget {
  jobId:          string;
  taskIndex:      number;
  jobStatus:      string;
  taskStatus:     string;
  threadId?:      string;
  parentChannel?:  string;
  parentThreadId?: string;
}

export interface AgentJobMessage {
  id:         string;
  jobId:      string;
  taskIndex:  number;
  message:    string;
  createdAt:  number;
  deliveredAt?:  number;
}

export interface AgentJobCheckin {
  step:         string;
  summary:      string;
  filesTouched: string[];
  blockers:     string[];
  percent?:     number;
  createdAt:    number;
}

export interface AgentJobTaskTelemetry {
  latestCheckin: AgentJobCheckin | null;
  checkins:      AgentJobCheckin[];
  undeliveredMessages: number;
}

function rowToTarget(row: any): AgentJobTaskTarget {
  return {
    jobId:           row.job_id,
    taskIndex:       Number(row.task_index),
    jobStatus:       row.job_status,
    taskStatus:      row.task_status,
    threadId:        row.thread_id || undefined,
    parentChannel:   row.parent_channel || undefined,
    parentThreadId:  row.parent_thread_id || undefined,
  };
}

function rowToMessage(row: any): AgentJobMessage {
  return {
    id:          row.id,
    jobId:       row.job_id,
    taskIndex:   Number(row.task_index),
    message:     row.message,
    createdAt:   new Date(row.created_at).getTime(),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at).getTime() : undefined,
  };
}

function rowToCheckin(row: any): AgentJobCheckin {
  return {
    step:         row.step,
    summary:      row.summary,
    filesTouched: Array.isArray(row.files_touched) ? row.files_touched : [],
    blockers:     Array.isArray(row.blockers) ? row.blockers : [],
    percent:      row.percent === null || row.percent === undefined ? undefined : Number(row.percent),
    createdAt:    new Date(row.created_at).getTime(),
  };
}

export class AgentJobMessagingModel {
  static async taskForThread(threadId: string): Promise<AgentJobTaskTarget | null> {
    const rows = await postgresClient.query<any>(
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

    return rows?.[0] ? rowToTarget(rows[0]) : null;
  }

  static async targetsForJob(jobId: string, requestedTaskIndex?: number): Promise<AgentJobTaskTarget[]> {
    const rows = await postgresClient.query<any>(
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
    const targets = (rows ?? []).map(rowToTarget);

    return targets.filter(target =>
      (requestedTaskIndex === undefined || target.taskIndex === requestedTaskIndex) &&
      ['queued', 'running'].includes(target.taskStatus),
    );
  }

  static async queueMessage(target: AgentJobTaskTarget, message: string): Promise<AgentJobMessage> {
    const id = crypto.randomUUID();
    const rows = await postgresClient.query<any>(
      `INSERT INTO agent_job_messages (id, job_id, task_index, message)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, target.jobId, target.taskIndex, message],
    );

    return rowToMessage(rows[0]);
  }

  static async pendingMessagesForThread(threadId: string): Promise<AgentJobMessage[]> {
    const rows = await postgresClient.query<any>(
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

    return (rows ?? []).map(rowToMessage);
  }

  static async markMessagesDelivered(ids: string[], threadId: string): Promise<void> {
    if (ids.length === 0) return;
    await postgresClient.query(
      `UPDATE agent_job_messages
          SET delivered_at = COALESCE(delivered_at, now()), delivery_thread_id = $2
        WHERE id = ANY($1::text[])`,
      [ids, threadId],
    );
  }

  static async appendCheckin(threadId: string, input: {
    step: string;
    summary: string;
    filesTouched?: string[];
    blockers?: string[];
    percent?: number;
  }): Promise<{ target: AgentJobTaskTarget; checkin: AgentJobCheckin } | null> {
    const target = await this.taskForThread(threadId);
    if (!target || target.jobStatus !== 'running' || !['queued', 'running'].includes(target.taskStatus)) return null;

    return this.insertCheckin(target, input);
  }

  /**
   * Append a check-in using the worker identity stamped by spawn_agent.
   * The task index is only accepted when its persisted threadId matches the
   * caller's bound graph thread, so a session cannot report for a sibling task.
   */
  static async appendCheckinForTask(jobId: string, taskIndex: number, threadId: string, input: {
    step: string;
    summary: string;
    filesTouched?: string[];
    blockers?: string[];
    percent?: number;
  }): Promise<{ target: AgentJobTaskTarget; checkin: AgentJobCheckin } | null> {
    const rows = await postgresClient.query<any>(
      `SELECT j.job_id, j.status AS job_status, j.parent_channel, j.parent_thread_id,
              task.ordinality - 1 AS task_index,
              task.value->>'status' AS task_status,
              task.value->>'threadId' AS thread_id
         FROM agent_jobs j
         CROSS JOIN LATERAL jsonb_array_elements(j.tasks) WITH ORDINALITY AS task(value, ordinality)
        WHERE j.job_id = $1
          AND task.ordinality - 1 = $2
          AND task.value->>'threadId' = $3
        LIMIT 1`,
      [jobId, taskIndex, threadId],
    );
    const target = rows?.[0] ? rowToTarget(rows[0]) : null;
    if (!target || target.jobStatus !== 'running' || !['queued', 'running'].includes(target.taskStatus)) return null;

    return this.insertCheckin(target, input);
  }

  private static async insertCheckin(target: AgentJobTaskTarget, input: {
    step: string;
    summary: string;
    filesTouched?: string[];
    blockers?: string[];
    percent?: number;
  }): Promise<{ target: AgentJobTaskTarget; checkin: AgentJobCheckin }> {

    const rows = await postgresClient.query<any>(
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

    return { target, checkin: rowToCheckin(rows[0]) };
  }

  static async telemetryForJob(jobId: string): Promise<Record<number, AgentJobTaskTelemetry>> {
    const [checkinRows, messageRows] = await Promise.all([
      postgresClient.query<any>(
        `SELECT * FROM agent_job_checkins
          WHERE job_id = $1
          ORDER BY task_index, created_at DESC`,
        [jobId],
      ),
      postgresClient.query<any>(
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
      if (entry.checkins.length < 3) entry.checkins.push(rowToCheckin(row));
      entry.latestCheckin ??= rowToCheckin(row);
    }
    for (const row of messageRows ?? []) {
      ensure(Number(row.task_index)).undeliveredMessages = Number(row.count);
    }

    return telemetry;
  }
}
