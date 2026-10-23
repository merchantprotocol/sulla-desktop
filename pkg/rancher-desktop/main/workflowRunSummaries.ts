/**
 * Read-only run summaries for the Studio workflows list.
 *
 * Everything here comes from data that already exists:
 *   - last 12 runs  → workflow_executions (same Postgres the manager writes)
 *   - trigger       → the trigger node in the workflow definition
 *   - next run      → the live scheduler's next invocation, or the schedule
 *                     trigger's cron under the manager's rules (same
 *                     buildCronExpression, empty timezone = UTC)
 *   - runs on       → workflows.location, plus this machine's hostname
 *
 * Runs of `server` workflows execute on the server's manager and land in its
 * database, not this one, so their history is empty here by design.
 */

import os from 'node:os';

import parser from 'cron-parser';

import { buildCronExpression, getWorkflowSchedulerService } from '@pkg/agent/services/WorkflowSchedulerService';

export type RunOutcome = 'ok' | 'failed' | 'running' | 'stopped';

export interface RunSummary {
  executionId: string;
  outcome:     RunOutcome;
  startedAt:   string | null;
  completedAt: string | null;
  trigger:     string;
}

export interface WorkflowTriggerInfo {
  /** Icon key for the list: schedule | manual | chat | calendar | heartbeat | event */
  kind:  string;
  label: string;
}

export interface WorkflowRunInfo {
  enabled:   boolean;
  location:  'desktop' | 'server';
  trigger:   WorkflowTriggerInfo;
  /** ISO time of the next scheduled fire, or null when nothing is armed. */
  nextRunAt: string | null;
  /** Event-driven triggers have no fire time but do have a real "next". */
  nextRunOn: string | null;
  /** Newest first, at most 12. */
  runs:      RunSummary[];
}

export interface WorkflowRunSummaries {
  deviceName: string;
  workflows:  Record<string, WorkflowRunInfo>;
}

export interface WorkflowRunDetail {
  executionId: string;
  workflowId:  string;
  runNumber:   number;
  outcome:     RunOutcome;
  trigger:     string;
  startedAt:   string | null;
  completedAt: string | null;
  error:       string | null;
  location:    'desktop' | 'server';
  deviceName:  string;
  agents:      string[];
  nextRunAt:   string | null;
  nextRunOn:   string | null;
}

const STOPPED_REASONS = new Set(['user_aborted', 'workflow_archived']);
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

export function deviceName(): string {
  return os.hostname().replace(/\.local$/i, '') || 'This Mac';
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function runOutcome(row: { status?: string; error?: string | null; terminal_reason?: string | null }): RunOutcome {
  if (row.status === 'completed') return 'ok';
  if (row.status === 'running' || row.status === 'suspended') return 'running';
  if (STOPPED_REASONS.has(String(row.terminal_reason ?? '')) || STOPPED_REASONS.has(String(row.error ?? ''))) return 'stopped';

  return 'failed';
}

/** How a run was started, from the columns each launcher writes. */
export function runTrigger(row: { trigger_key?: string | null; schedule_node_id?: string | null; parent_execution_id?: string | null; trigger_input?: string | null }): string {
  const input = String(row.trigger_input ?? '');
  if (input.startsWith('Catch-up for')) return 'Schedule catch-up';
  if (row.schedule_node_id || String(row.trigger_key ?? '').startsWith('schedule:') || input.startsWith('Scheduled trigger')) return 'Schedule';
  if (row.parent_execution_id) return 'Sub-workflow';

  return 'On demand';
}

function clockLabel(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;

  return `${ h12 }:${ String(minute).padStart(2, '0') } ${ hour < 12 ? 'AM' : 'PM' }`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;

  return `${ n }${ s[(v - 20) % 10] || s[v] || s[0] }`;
}

export function scheduleLabel(config: Record<string, any>): string {
  const minute = Number(config.minute ?? 0);
  const hour = Number(config.hour ?? 9);
  switch (config.frequency || 'daily') {
  case 'every-minutes': return `Every ${ Number(config.intervalMinutes ?? 15) } min`;
  case 'hourly':        return minute ? `Hourly at :${ String(minute).padStart(2, '0') }` : 'Hourly';
  case 'daily':         return `Daily ${ clockLabel(hour, minute) }`;
  case 'weekly':        return `${ DAYS[Number(config.dayOfWeek ?? 1)] ?? 'Weekly' } ${ clockLabel(hour, minute) }`;
  case 'monthly':       return `Monthly on the ${ ordinal(Number(config.dayOfMonth ?? 1)) }, ${ clockLabel(hour, minute) }`;
  default:              return 'Schedule';
  }
}

const EVENT_TRIGGERS: Record<string, { kind: string; label: string; next: string }> = {
  'chat-app':         { kind: 'chat', label: 'Chat app message', next: 'On next message' },
  'chat-completions': { kind: 'chat', label: 'API request', next: 'On next request' },
  'sulla-desktop':    { kind: 'chat', label: 'Sulla chat', next: 'On next message' },
  workbench:          { kind: 'chat', label: 'Workbench', next: 'On next request' },
  calendar:           { kind: 'calendar', label: 'Calendar event', next: 'On next event' },
  heartbeat:          { kind: 'heartbeat', label: 'Heartbeat', next: 'On next heartbeat' },
};

function triggerNodes(nodes: unknown): any[] {
  return (Array.isArray(nodes) ? nodes : []).filter((node: any) => node?.data?.category === 'trigger');
}

export function describeTrigger(nodes: unknown): { trigger: WorkflowTriggerInfo; nextRunOn: string | null } {
  const triggers = triggerNodes(nodes);
  const schedules = triggers.filter(node => node.data.subtype === 'schedule');
  if (schedules.length) {
    const label = scheduleLabel(schedules[0].data.config ?? {});

    return { trigger: { kind: 'schedule', label: schedules.length > 1 ? `${ label } +${ schedules.length - 1 }` : label }, nextRunOn: null };
  }
  const event = triggers.map(node => EVENT_TRIGGERS[node.data.subtype]).find(Boolean);
  if (event) return { trigger: { kind: event.kind, label: event.label }, nextRunOn: event.next };
  if (triggers.length) return { trigger: { kind: 'manual', label: 'Manual' }, nextRunOn: null };

  return { trigger: { kind: 'none', label: 'No trigger' }, nextRunOn: null };
}

/** Earliest next fire across a workflow's schedule nodes, mirroring how the schedulers arm them. */
export function nextScheduledFire(nodes: unknown, defaultTz: string, now = new Date()): string | null {
  let earliest: Date | null = null;
  for (const node of triggerNodes(nodes)) {
    if (node.data.subtype !== 'schedule') continue;
    const config = node.data.config ?? {};
    const cron = buildCronExpression(config);
    if (!cron) continue;
    try {
      const tz = String(config.timezone ?? '').trim() || defaultTz;
      const next = parser.parseExpression(cron, { tz, currentDate: now }).next().toDate();
      if (!earliest || next < earliest) earliest = next;
    } catch { /* invalid cron or tz never arms either */ }
  }

  return earliest ? earliest.toISOString() : null;
}

async function scheduleContext(): Promise<{ defaultTz: (location: string) => string; armed: Map<string, string> }> {
  const { getWorkflowManagerClient } = await import('@pkg/agent/services/WorkflowManagerClient');
  const managerOwns = await getWorkflowManagerClient().isHealthy();
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const armed = new Map<string, string>();
  if (!managerOwns) {
    // Desktop recovery scheduler is live — read its real next invocations.
    for (const job of getWorkflowSchedulerService().getScheduledJobs()) {
      if (!job.nextInvocation) continue;
      const current = armed.get(job.workflowId);
      if (!current || job.nextInvocation < current) armed.set(job.workflowId, job.nextInvocation);
    }
  }

  // The manager container defaults an empty timezone to UTC; the in-process
  // scheduler defaults to the system zone.
  return { defaultTz: location => (managerOwns || location === 'server' ? 'UTC' : systemTz), armed };
}

function nextRunFor(row: any, ctx: Awaited<ReturnType<typeof scheduleContext>>): string | null {
  if (row.status !== 'production' || row.enabled === false) return null;

  return ctx.armed.get(row.id) ?? nextScheduledFire(row.nodes, ctx.defaultTz(row.location));
}

const RUN_COLUMNS = `execution_id, workflow_id, status, started_at, completed_at, error, terminal_reason,
  trigger_key, schedule_node_id, parent_execution_id, LEFT(trigger_input, 64) AS trigger_input`;

function toRunSummary(row: any): RunSummary {
  return {
    executionId: row.execution_id,
    outcome:     runOutcome(row),
    startedAt:   iso(row.started_at),
    completedAt: iso(row.completed_at),
    trigger:     runTrigger(row),
  };
}

export async function loadWorkflowRunSummaries(): Promise<WorkflowRunSummaries> {
  const { postgresClient } = await import('@pkg/agent/database/PostgresClient');
  const [workflowRows, runRows, ctx] = await Promise.all([
    postgresClient.queryAll(`SELECT id, status, enabled, location, definition->'nodes' AS nodes FROM workflows`, []),
    postgresClient.queryAll(
      `SELECT ${ RUN_COLUMNS } FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY started_at DESC NULLS LAST) AS rn
           FROM workflow_executions
       ) ranked
       WHERE rn <= 12
       ORDER BY workflow_id, started_at DESC NULLS LAST`,
      [],
    ),
    scheduleContext(),
  ]);

  const runsByWorkflow = new Map<string, RunSummary[]>();
  for (const row of runRows as any[]) {
    const list = runsByWorkflow.get(row.workflow_id) ?? [];
    list.push(toRunSummary(row));
    runsByWorkflow.set(row.workflow_id, list);
  }

  const workflows: Record<string, WorkflowRunInfo> = {};
  for (const row of workflowRows as any[]) {
    const { trigger, nextRunOn } = describeTrigger(row.nodes);
    const live = row.status === 'production' && row.enabled !== false;
    workflows[row.id] = {
      enabled:   row.enabled !== false,
      location:  row.location === 'server' ? 'server' : 'desktop',
      trigger,
      nextRunAt: nextRunFor(row, ctx),
      nextRunOn: live ? nextRunOn : null,
      runs:      runsByWorkflow.get(row.id) ?? [],
    };
  }

  return { deviceName: deviceName(), workflows };
}

export async function loadWorkflowRunDetail(executionId: string): Promise<WorkflowRunDetail | null> {
  const { postgresClient } = await import('@pkg/agent/database/PostgresClient');
  const run: any = await postgresClient.queryOne(
    `SELECT ${ RUN_COLUMNS },
            (SELECT COUNT(*) FROM workflow_executions prior
              WHERE prior.workflow_id = e.workflow_id AND prior.started_at <= e.started_at)::int AS run_number
       FROM workflow_executions e WHERE execution_id = $1 LIMIT 1`,
    [executionId],
  );
  if (!run) return null;
  const workflow: any = await postgresClient.queryOne(
    `SELECT id, status, enabled, location, definition->'nodes' AS nodes FROM workflows WHERE id = $1 LIMIT 1`,
    [run.workflow_id],
  );
  const ctx = await scheduleContext();
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const agents = [...new Set(nodes
    .filter((node: any) => node?.data?.subtype === 'agent')
    .map((node: any) => String(node.data.config?.agentName || node.data.label || '').trim())
    .filter(Boolean))] as string[];
  const live = workflow?.status === 'production' && workflow?.enabled !== false;

  return {
    executionId: run.execution_id,
    workflowId:  run.workflow_id,
    runNumber:   Number(run.run_number ?? 0),
    outcome:     runOutcome(run),
    trigger:     runTrigger(run),
    startedAt:   iso(run.started_at),
    completedAt: iso(run.completed_at),
    error:       run.error ?? null,
    location:    workflow?.location === 'server' ? 'server' : 'desktop',
    deviceName:  deviceName(),
    agents,
    nextRunAt:   workflow ? nextRunFor(workflow, ctx) : null,
    nextRunOn:   workflow && live ? describeTrigger(workflow.nodes).nextRunOn : null,
  };
}
