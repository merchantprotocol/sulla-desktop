// agentsIpc.ts — Thin read-only IPC surface for the Agents tab in the renderer UI.
//
// Flow: main owns the agent registry, heartbeat service, job registry, and
// workflow scheduler. The UI asks "what's running?" via agents:list and
// polls every 3s (v1 — push via a subscription channel is Stage 3).
//
// There is NO reactive two-way sync. Renderer mirrors main's state; that's it.

import { ipcMain } from 'electron';

import type { ActiveAgent } from '@pkg/agent/services/ActiveAgentsRegistry';

// ── Response shape ───────────────────────────────────────────────────────────

export interface AgentsListResponse {
  agents: {
    name:         string;
    channel:      string;
    type:         ActiveAgent['type'];
    status:       ActiveAgent['status'];
    statusNote?:  string;
    startedAt:    number;
    lastActiveAt: number;
  }[];
  heartbeat: {
    initialized:      boolean;
    isExecuting:      boolean;
    lastTriggerMs:    number;
    schedulerRunning: boolean;
    totalTriggers:    number;
    totalErrors:      number;
    totalSkips:       number;
    uptimeMs:         number;
  } | null;
  jobs: {
    jobId:      string;
    status:     string;
    createdAt:  number;
    finishedAt: number | null;
    taskCount:  number;
    error?:     string;
  }[];
  routines: {
    workflowId:     string;
    workflowName:   string;
    nodeId:         string;
    cronExpression: string;
    timezone:       string;
    nextInvocation: string | null;
  }[];
}

// ── IPC handler ──────────────────────────────────────────────────────────────

export function initAgentsIpc(): void {
  ipcMain.handle('agents:list', async (): Promise<AgentsListResponse> => {
    // Gather all four data sources in parallel. Each is wrapped so a
    // failure in one never blocks the others.

    const [agents, heartbeat, jobs, routines] = await Promise.all([
      fetchAgents(),
      fetchHeartbeat(),
      fetchJobs(),
      fetchRoutines(),
    ]);

    return { agents, heartbeat, jobs, routines };
  });
}

// ── Data fetchers ────────────────────────────────────────────────────────────

async function fetchAgents(): Promise<AgentsListResponse['agents']> {
  try {
    const { getActiveAgentsRegistry } = await import(
      '@pkg/agent/services/ActiveAgentsRegistry'
    );
    const all = await getActiveAgentsRegistry().getAllAgents();
    // Filter out human entries the same way list_agents.ts does.
    return all
      .filter(a => a.type !== 'human')
      .map(a => ({
        name:         a.name || a.agentId,
        channel:      a.channel,
        type:         a.type,
        status:       a.status,
        statusNote:   a.statusNote && a.statusNote !== 'idle' ? a.statusNote : undefined,
        startedAt:    a.startedAt,
        lastActiveAt: a.lastActiveAt,
      }));
  } catch {
    return [];
  }
}

async function fetchHeartbeat(): Promise<AgentsListResponse['heartbeat']> {
  try {
    const { getHeartbeatService } = await import(
      '@pkg/agent/services/HeartbeatService'
    );
    return getHeartbeatService().getStatus();
  } catch {
    return null;
  }
}

async function fetchJobs(): Promise<AgentsListResponse['jobs']> {
  try {
    const { getAllJobs } = await import(
      '@pkg/agent/tools/agents/jobRegistry'
    );
    const allJobs = await getAllJobs();

    return allJobs.map(j => ({
      jobId:      j.jobId,
      status:     j.status,
      createdAt:  j.createdAt,
      finishedAt: j.finishedAt,
      taskCount:  j.taskCount,
      error:      j.error,
    }));
  } catch {
    return [];
  }
}

async function fetchRoutines(): Promise<AgentsListResponse['routines']> {
  try {
    const { getWorkflowSchedulerService } = await import(
      '@pkg/agent/services/WorkflowSchedulerService'
    );
    return getWorkflowSchedulerService().getScheduledJobs();
  } catch {
    return [];
  }
}
