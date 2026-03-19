// WorkflowSchedulerService.ts
//
// Scans production workflows for `schedule` trigger nodes, registers cron jobs
// via node-schedule, and dispatches them through the same WebSocket channel
// mechanism that SchedulerService and HeartbeatService use.

import * as fs from 'fs';
import * as path from 'path';

import schedule from 'node-schedule';
import yaml from 'yaml';

import { getWebSocketClientService, type WebSocketMessage } from './WebSocketClientService';

import type {
  WorkflowDefinition,
  WorkflowNodeSerialized,
} from '@pkg/pages/editor/workflow/types';

// ── Types ──

interface ScheduledWorkflowJob {
  workflowId:     string;
  workflowName:   string;
  nodeId:         string;
  cronExpression: string;
  timezone:       string;
  job:            schedule.Job;
}

// ── Constants ──

const FRONTEND_CHANNEL_ID = 'sulla-desktop';
const ACK_TIMEOUT_MS      = 3_000;

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
  const hour   = Number(config.hour ?? 9);

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
  private readonly wsService = getWebSocketClientService();
  private wsInitialized = false;
  private unsubscribeFrontend: (() => void) | null = null;
  private pendingAcks = new Map<string, { resolve: (value: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log('[WorkflowSchedulerService] Initializing...');

    try {
      this.scanAndSchedule();
    } catch (err) {
      console.error('[WorkflowSchedulerService] Initialization failed:', err);
    }

    this.initialized = true;
  }

  /**
   * Re-scan workflows and update schedules.
   * Call this when workflows are saved/deleted from production.
   */
  refresh(): void {
    console.log('[WorkflowSchedulerService] Refreshing schedules...');
    this.cancelAll();
    this.scanAndSchedule();
  }

  /**
   * Cancel all scheduled workflow jobs.
   */
  shutdown(): void {
    this.cancelAll();
    if (this.unsubscribeFrontend) {
      this.unsubscribeFrontend();
      this.unsubscribeFrontend = null;
    }
    this.wsInitialized = false;
    this.initialized = false;
    console.log('[WorkflowSchedulerService] Shut down');
  }

  /**
   * Get info about currently scheduled workflow jobs.
   */
  getScheduledJobs(): Array<{
    workflowId:     string;
    workflowName:   string;
    nodeId:         string;
    cronExpression: string;
    timezone:       string;
    nextInvocation: string | null;
  }> {
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

  private scanAndSchedule(): void {
    const { resolveSullaWorkflowsProductionDir } = require('@pkg/agent/utils/sullaPaths');
    const workflowsDir: string = resolveSullaWorkflowsProductionDir();

    if (!fs.existsSync(workflowsDir)) {
      console.log(`[WorkflowSchedulerService] No workflows dir: ${ workflowsDir }`);
      return;
    }

    const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !(entry.name.endsWith('.yaml') || entry.name.endsWith('.json'))) continue;

      try {
        const filePath = path.join(workflowsDir, entry.name);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const definition: WorkflowDefinition = entry.name.endsWith('.json')
          ? JSON.parse(raw)
          : yaml.parse(raw);

        for (const node of definition.nodes) {
          if (node.data.category === 'trigger' && node.data.subtype === 'schedule') {
            const scheduled = this.registerScheduleNode(definition, node);
            if (scheduled) count++;
          }
        }
      } catch (err) {
        console.warn(`[WorkflowSchedulerService] Failed to parse ${ entry.name }:`, err);
      }
    }

    console.log(`[WorkflowSchedulerService] Registered ${ count } schedule trigger(s)`);
  }

  private registerScheduleNode(
    definition: WorkflowDefinition,
    node: WorkflowNodeSerialized,
  ): boolean {
    const config = node.data.config || {};
    const cronExpression = buildCronExpression(config);

    if (!cronExpression) {
      console.warn(`[WorkflowSchedulerService] Skipping schedule trigger "${ node.data.label }" in "${ definition.name }" — could not build cron from config`);
      return false;
    }

    const timezone = (config.timezone as string || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const jobKey = `${ definition.id }:${ node.id }`;

    const job = schedule.scheduleJob(
      { rule: cronExpression, tz: timezone },
      async() => {
        console.log(`[WorkflowSchedulerService] Cron fired for workflow "${ definition.name }" (node ${ node.id })`);
        await this.triggerWorkflow(definition, node);
      },
    );

    if (!job) {
      console.warn(`[WorkflowSchedulerService] Invalid cron "${ cronExpression }" for "${ definition.name }"`);
      return false;
    }

    this.scheduledJobs.set(jobKey, {
      workflowId:   definition.id,
      workflowName: definition.name,
      nodeId:       node.id,
      cronExpression,
      timezone,
      job,
    });

    const next = job.nextInvocation();
    console.log(`[WorkflowSchedulerService] Scheduled "${ definition.name }" (${ cronExpression } ${ timezone }) — next: ${ next?.toISOString() ?? 'none' }`);

    return true;
  }

  private async triggerWorkflow(
    definition: WorkflowDefinition,
    node: WorkflowNodeSerialized,
  ): Promise<void> {
    try {
      const prompt = this.buildTriggerPrompt(definition, node);

      const acknowledged = await this.sendToFrontend(definition, prompt);
      if (acknowledged) {
        console.log(`[WorkflowSchedulerService] Frontend acknowledged workflow "${ definition.name }"`);
        return;
      }

      console.warn(`[WorkflowSchedulerService] Frontend did not ACK workflow "${ definition.name }" — skipping (frontend must be running to execute scheduled workflows)`);
    } catch (err) {
      console.error(`[WorkflowSchedulerService] Failed to trigger workflow "${ definition.name }":`, err);
    }
  }

  private buildTriggerPrompt(
    definition: WorkflowDefinition,
    node: WorkflowNodeSerialized,
  ): string {
    const config = node.data.config || {};
    const timezone = (config.timezone as string || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const formattedTime = now.toLocaleString('en-US', {
      timeZone: timezone,
      weekday:  'long',
      year:     'numeric',
      month:    'long',
      day:      'numeric',
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   true,
    });

    const description = (config.triggerDescription as string || '').trim();

    return [
      `A scheduled workflow has been triggered.`,
      ``,
      `## Workflow Details`,
      ``,
      `Name: ${ definition.name }`,
      `Description: ${ definition.description || 'None' }`,
      `Schedule: ${ buildCronExpression(config) || 'unknown' }`,
      `Timezone: ${ timezone }`,
      `Triggered at: ${ formattedTime }`,
      description ? `Trigger description: ${ description }` : '',
      ``,
      `Execute workflow "${ definition.name }" now.`,
    ].filter(Boolean).join('\n');
  }

  private buildEventPayload(definition: WorkflowDefinition, prompt: string) {
    return {
      type: 'user_message',
      data: {
        role:     'user',
        content:  prompt,
        metadata: {
          origin:       'workflow-scheduler',
          workflowId:   definition.id,
          workflowName: definition.name,
          triggerType:  'schedule',
        },
      },
      timestamp: Date.now(),
    };
  }

  private ensureFrontendListener(): void {
    if (this.wsInitialized) return;

    this.wsService.connect(FRONTEND_CHANNEL_ID);
    this.unsubscribeFrontend = this.wsService.onMessage(FRONTEND_CHANNEL_ID, (msg: WebSocketMessage) => {
      if (msg.type !== 'workflow_scheduler_ack') return;

      const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
      const workflowId = data?.workflowId as string;
      if (!workflowId) return;

      const pending = this.pendingAcks.get(workflowId);
      if (!pending) return;

      clearTimeout(pending.timer);
      pending.resolve(true);
      this.pendingAcks.delete(workflowId);
    }) ?? null;

    this.wsInitialized = true;
  }

  private async sendToFrontend(definition: WorkflowDefinition, prompt: string): Promise<boolean> {
    this.ensureFrontendListener();
    const message = this.buildEventPayload(definition, prompt);

    const sent = await this.wsService.send(FRONTEND_CHANNEL_ID, message);
    if (!sent) {
      console.warn(`[WorkflowSchedulerService] Failed to send to frontend for "${ definition.name }"`);
      return false;
    }

    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(definition.id);
        resolve(false);
      }, ACK_TIMEOUT_MS);

      this.pendingAcks.set(definition.id, { resolve, timer });
    });
  }

  private cancelAll(): void {
    for (const [key, { job }] of this.scheduledJobs) {
      job.cancel();
      console.log(`[WorkflowSchedulerService] Cancelled job: ${ key }`);
    }
    this.scheduledJobs.clear();
  }
}
