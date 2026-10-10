// agentsIpc.ts — Thin read-only IPC surface for the Agents tab in the renderer UI.
//
// Flow: main owns the agent registry, heartbeat service, job registry, and
// workflow scheduler. The UI asks "what's running?" via agents:list and
// polls every 3s (v1 — push via a subscription channel is Stage 3).
//
// There is NO reactive two-way sync. Renderer mirrors main's state; that's it.
//
// Clicking an agent opens its stored conversations: agents:conversations lists
// the conversation_history rows for that agent's channel, and
// agents:conversation reads one conversation's JSONL message log.

import { ipcMain } from 'electron';

import { readConversationLog, readConversationPreview, type AgentConversationEntry } from './agentConversationLog';

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

export interface AgentDefinitionResponse {
  id:                 string;
  slug:               string;
  name:               string;
  description:        string;
  provider:           string | null;
  model:              string | null;
  prompt:             string;
  sourceKind:         string;
  marketplaceVersion: string | null;
  status:             string;
  enabled:            boolean;
}

export interface AgentConversationSummary {
  id:           string;
  title:        string;
  status:       string;
  messageCount: number;
  createdAt:    string;
  lastActiveAt: string;
  preview:      string;
}

export interface AgentConversationDetail {
  id:           string;
  channel:      string | null;
  title:        string;
  status:       string;
  createdAt:    string;
  lastActiveAt: string;
  entries:      AgentConversationEntry[];
  truncated:    boolean;
  missingLog:   boolean;
}

const MAX_CONVERSATION_PAGE = 200;

// First-prompt previews never change once written, and the list is re-read on
// every poll — cache them so each refresh doesn't reopen every log file.
const previewCache = new Map<string, string>();
const MAX_PREVIEW_CACHE = 2000;

async function previewFor(id: string, logFile: string | undefined, logsDir: string): Promise<string> {
  const cached = previewCache.get(id);

  if (cached) return cached;
  const preview = await readConversationPreview(logFile, logsDir);

  if (preview) {
    if (previewCache.size >= MAX_PREVIEW_CACHE) previewCache.clear();
    previewCache.set(id, preview);
  }

  return preview;
}

// ── IPC handler ──────────────────────────────────────────────────────────────

export function initAgentsIpc(): void {
  ipcMain.handle('agent-definitions:list', async(): Promise<AgentDefinitionResponse[]> => {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    return (await agentDefinitionService.list()).filter(a => a.status !== 'archive').map(a => ({
      id:                 a.id,
      slug:               a.slug,
      name:               a.name,
      description:        a.description,
      provider:           a.provider,
      model:              a.model,
      prompt:             a.prompt_content,
      sourceKind:         a.source_kind,
      marketplaceVersion: a.marketplace_version,
      status:             a.status,
      enabled:            a.enabled,
    }));
  });

  ipcMain.handle('agent-definitions:create', async(_event, input: { slug: string; name: string; description?: string; provider?: string; model?: string; prompt: string }) => {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    return agentDefinitionService.create({
      slug:          input.slug,
      name:          input.name,
      description:   input.description ?? '',
      provider:      input.provider ?? null,
      model:         input.model ?? null,
      systemPrompt:  input.prompt,
      promptContent: input.prompt,
      promptFiles:   { 'prompt.md': input.prompt },
      status:        'production',
      sourceKind:    'local',
    });
  });

  ipcMain.handle('agent-definitions:update', async(_event, id: string, patch: { name?: string; description?: string; provider?: string; model?: string; prompt?: string }) => {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    return agentDefinitionService.update(id, {
      ...patch,
      ...(patch.prompt !== undefined ? { systemPrompt: patch.prompt, promptContent: patch.prompt } : {}),
    });
  });

  ipcMain.handle('agent-definitions:delete', async(_event, id: string) => {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    return agentDefinitionService.delete(id);
  });

  ipcMain.handle('agent-definitions:export', async(_event, slug: string) => {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    return agentDefinitionService.exportManifest(slug);
  });

  ipcMain.handle('agent-definitions:import', async(_event, manifest: import('@pkg/agent/services/AgentDefinitionService').AgentMarketplaceManifest) => {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    return agentDefinitionService.importManifest(manifest);
  });

  ipcMain.handle('agents:list', async(): Promise<AgentsListResponse> => {
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

  ipcMain.handle('agents:conversations', async(_event, channel: string, limit = 50, offset = 0): Promise<AgentConversationSummary[]> => {
    if (!channel || typeof channel !== 'string') return [];
    const pageSize = Math.min(Math.max(1, Number(limit) || 50), MAX_CONVERSATION_PAGE);
    const start = Math.max(0, Number(offset) || 0);

    const { ConversationHistoryModel } = await import('@pkg/agent/database/models/ConversationHistoryModel');
    const { resolveSullaLogsDir } = await import('@pkg/agent/utils/sullaPaths');
    const logsDir = resolveSullaLogsDir();
    const rows = await ConversationHistoryModel.getByChannel(channel, pageSize, start);

    return Promise.all(rows.map(async row => ({
      id:           row.id,
      title:        row.title || row.id,
      status:       row.status,
      messageCount: Number(row.message_count) || 0,
      createdAt:    toIso(row.created_at),
      lastActiveAt: toIso(row.last_active_at),
      preview:      row.summary || await previewFor(row.id, row.log_file, logsDir),
    })));
  });

  ipcMain.handle('agents:conversation', async(_event, id: string): Promise<AgentConversationDetail | null> => {
    if (!id || typeof id !== 'string') return null;

    const { ConversationHistoryModel } = await import('@pkg/agent/database/models/ConversationHistoryModel');
    const { resolveSullaLogsDir } = await import('@pkg/agent/utils/sullaPaths');
    const row = await ConversationHistoryModel.getById(id);

    if (!row) return null;
    const log = await readConversationLog(row.log_file, resolveSullaLogsDir());

    return {
      id:           row.id,
      channel:      row.channel_id ?? null,
      title:        row.title || row.id,
      status:       row.status,
      createdAt:    toIso(row.created_at),
      lastActiveAt: toIso(row.last_active_at),
      ...log,
    };
  });
}

/** pg returns TIMESTAMPTZ as Date; normalise to an ISO string for IPC. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();

  return value ? String(value) : '';
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
