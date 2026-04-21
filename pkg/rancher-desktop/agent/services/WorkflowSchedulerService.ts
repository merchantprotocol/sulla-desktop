// WorkflowSchedulerService.ts
//
// Scans production workflows in the Postgres `workflows` table for
// `schedule` trigger nodes, registers cron jobs via node-schedule, and
// fires routine execution directly through the shared `executeRoutine`
// helper when a cron trips.
//
// The old YAML-scan + chat-WebSocket handoff is gone — scheduled
// workflows now execute in-process without any frontend ack round-trip.

import schedule from 'node-schedule';

// ── Types ──

interface ScheduleNode {
  id:    string;
  data?: {
    category?: string;
    subtype?:  string;
    label?:    string;
    config?:   Record<string, unknown>;
  };
}

interface ScheduledWorkflowJob {
  workflowId:     string;
  workflowName:   string;
  nodeId:         string;
  cronExpression: string;
  timezone:       string;
  job:            schedule.Job;
}

interface ProductionRow {
  attributes: {
    id:         string;
    name:       string;
    definition: Record<string, unknown>;
  };
}

// ── Cron builder ──

/**
 * Convert user-friendly schedule config into a cron expression.
 *   every-minutes → *\/N * * * *
 *   hourly        → M * * * *
 *   daily         → M H * * *
 *   weekly        → M H * * D
 *   monthly       → M H D * *
 */
function buildCronExpression(config: Record<string, unknown>): string | null {
  const freq = (config.frequency as string) || 'daily';
  const minute = Number(config.minute ?? 0);
  const hour = Number(config.hour ?? 9);

  switch (freq) {
  case 'every-minutes': {
    const interval = Number(config.intervalMinutes ?? 15);
    if (interval <= 0 || interval > 59) return null;

    return `*/${ interval } * * * *`;
  }
  case 'hourly':
    return `${ minute } * * * *`;
  case 'daily':
    return `${ minute } ${ hour } * * *`;
  case 'weekly': {
    const dow = Number(config.dayOfWeek ?? 1);

    return `${ minute } ${ hour } * * ${ dow }`;
  }
  case 'monthly': {
    const dom = Number(config.dayOfMonth ?? 1);

    return `${ minute } ${ hour } ${ dom } * *`;
  }
  default:
    return null;
  }
}

// ── Singleton ──

let instance: WorkflowSchedulerService | null = null;

export function getWorkflowSchedulerService(): WorkflowSchedulerService {
  if (!instance) {
    instance = new WorkflowSchedulerService();
  }
  return instance;
}

// ── Service ──

export class WorkflowSchedulerService {
  private initialized = false;
  private scheduledJobs = new Map<string, ScheduledWorkflowJob>();

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.initialized = true;
    await this.scanAndSchedule();
  }

  /**
   * Re-scan production workflows in Postgres and rebuild the cron
   * registry. Called on `workflow-save` / promotion events.
   */
  async refresh(): Promise<void> {
    await this.scanAndSchedule();
  }

  /**
   * Cancel all scheduled workflow jobs and tear the service down.
   */
  shutdown(): void {
    this.cancelAll();
    this.initialized = false;
    console.log('[WorkflowSchedulerService] Shut down');
  }

  /**
   * Get info about currently scheduled workflow jobs.
   */
  getScheduledJobs(): {
    workflowId:     string;
    workflowName:   string;
    nodeId:         string;
    cronExpression: string;
    timezone:       string;
    nextInvocation: string | null;
  }[] {
    return Array.from(this.scheduledJobs.values()).map(j => ({
      workflowId:     j.workflowId,
      workflowName:   j.workflowName,
      nodeId:         j.nodeId,
      cronExpression: j.cronExpression,
      timezone:       j.timezone,
      nextInvocation: j.job.nextInvocation()?.toISOString() ?? null,
    }));
  }

  // ── Private ──

  /**
   * Query the DB for production workflows and (re)register a cron job
   * for each `trigger`/`schedule` node in their definitions. Wipes
   * existing jobs first so refreshes don't double-schedule.
   *
   * Dynamic import keeps the Postgres layer out of the main-process
   * startup bundle — same pattern as sullaWorkflowEvents.ts and
   * sullaRoutineTemplateEvents.ts.
   */
  private async scanAndSchedule(): Promise<void> {
    this.cancelAll();

    let rows: ProductionRow[] = [];
    try {
      const { WorkflowModel } = await import('@pkg/agent/database/models/WorkflowModel');
      rows = (await WorkflowModel.listByStatus('production')) as unknown as ProductionRow[];
    } catch (err) {
      console.warn('[WorkflowSchedulerService] Failed to load production workflows from DB:', err);
      return;
    }

    let count = 0;
    for (const row of rows) {
      const { id, name } = row.attributes;
      const definition = row.attributes.definition || {};
      const nodes = Array.isArray((definition as any).nodes) ? (definition as any).nodes as ScheduleNode[] : [];

      for (const node of nodes) {
        if (node?.data?.category !== 'trigger' || node?.data?.subtype !== 'schedule') continue;
        if (this.registerScheduleNode(id, name, node)) count++;
      }
    }

    console.log(`[WorkflowSchedulerService] Registered ${ count } schedule trigger(s) from ${ rows.length } production workflow(s)`);
  }

  private registerScheduleNode(
    workflowId:   string,
    workflowName: string,
    node:         ScheduleNode,
  ): boolean {
    const config = node.data?.config || {};
    const cronExpression = buildCronExpression(config);

    if (!cronExpression) {
      console.warn(`[WorkflowSchedulerService] Skipping schedule trigger "${ node.data?.label ?? node.id }" in "${ workflowName }" — could not build cron from config`);
      return false;
    }

    const timezone = (config.timezone as string || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const jobKey = `${ workflowId }:${ node.id }`;

    const job = schedule.scheduleJob(
      { rule: cronExpression, tz: timezone },
      async() => {
        console.log(`[WorkflowSchedulerService] Cron fired for workflow "${ workflowName }" (node ${ node.id })`);
        try {
          // Dynamic import — avoids a hard cycle between the scheduler
          // (agent-layer) and the routine execution helper (main-layer).
          const { executeRoutine } = await import('@pkg/main/sullaRoutineTemplateEvents');
          await executeRoutine(workflowId, `Scheduled trigger fired for routine ${ workflowName }`);
        } catch (err) {
          console.error(`[WorkflowSchedulerService] Failed to execute scheduled routine "${ workflowName }":`, err);
        }
      },
    );

    if (!job) {
      console.warn(`[WorkflowSchedulerService] Invalid cron "${ cronExpression }" for "${ workflowName }"`);
      return false;
    }

    this.scheduledJobs.set(jobKey, {
      workflowId,
      workflowName,
      nodeId: node.id,
      cronExpression,
      timezone,
      job,
    });

    const next = job.nextInvocation();
    console.log(`[WorkflowSchedulerService] Scheduled "${ workflowName }" (${ cronExpression } ${ timezone }) — next: ${ next?.toISOString() ?? 'none' }`);

    return true;
  }

  private cancelAll(): void {
    for (const [key, { job }] of this.scheduledJobs) {
      job.cancel();
      console.log(`[WorkflowSchedulerService] Cancelled job: ${ key }`);
    }
    this.scheduledJobs.clear();
  }
}
