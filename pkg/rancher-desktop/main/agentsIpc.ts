// agentsIpc.ts — IPC surface for the Agents tab in the renderer UI.
//
// Flow: main owns the agent registry, heartbeat service, job registry, and
// workflow scheduler. The UI asks "what's running?" via agents:list and
// polls every 3s (v1 — push via a subscription channel is Stage 3).
//
// State is polled; scoped job message and stop actions are explicit IPC calls.
//
// Clicking an agent opens its stored conversations: agents:conversations lists
// the conversation_history rows for that agent's channel, and
// agents:conversation reads one conversation's JSONL message log.

import { ipcMain } from 'electron';

import { readConversationLog, readConversationPreview, type AgentConversationEntry } from './agentConversationLog';

import type { ActiveAgent } from '@pkg/agent/services/ActiveAgentsRegistry';

// ── Response shape ───────────────────────────────────────────────────────────

export interface AgentsListResponse {
  updatedAt: number;
  agents: {
    agentId:      string;
    name:         string;
    channel:      string;
    role:         string;
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
    jobId:          string;
    status:         string;
    createdAt:      number;
    finishedAt:     number | null;
    taskCount:      number;
    error?:         string;
    parentChannel?: string;
    parentThreadId?: string;
    parentAgentId?: string;
    parentTitle?:   string;
    tasks: {
      taskIndex:      number;
      agentId:        string;
      label:          string;
      taskId?:        string;
      status:         string;
      threadId?:      string;
      startedAt:      number;
      finishedAt?:    number;
      depth:           number;
      kind:            'job' | 'tab';
      model?:          string;
      lastActivity:    string;
      lastActivityAt:  number;
      waitingForHuman: boolean;
      latestCheckin: {
        step:       string;
        summary:    string;
        blockers:   string[];
        percent?:   number;
        createdAt:  number;
      } | null;
    }[];
  }[];
  workflowRuns: {
    executionId: string;
    workflowId:  string;
    name:        string;
    slug:        string;
    status:      'running' | 'suspended' | 'failed';
    startedAt:   number;
    updatedAt:   number;
    activity:    string;
    progress?:   number;
    error?:      string;
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
  runLocation:        'vm' | 'container';
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

export interface ThreadAgentCard {
  jobId:          string;
  taskIndex:      number;
  agentId:        string;
  label:          string;
  status:         'running' | 'done' | 'failed' | 'stopped';
  createdAt:      number;
  finishedAt:     number | null;
  conversationId?: string;
  lastActivity:   string;
  lastActivityAt: number;
  /** 'tab' = a child running in (or opened as) its own chat tab. */
  kind:           'job' | 'tab';
  /** Return contract name; 'result' is the default contract. */
  contract:       string;
  /** Present for tab cards: what the renderer needs to focus or reopen the tab. */
  agentTab?: {
    contractId:    string;
    threadId:      string;
    agentName:     string;
    parentAgentId: string;
    depth:         number;
  };
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
      runLocation:        a.run_location,
    }));
  });

  ipcMain.handle('agent-definitions:create', async(_event, input: { slug: string; name: string; description?: string; provider?: string; model?: string; prompt: string; runLocation?: 'vm' | 'container' }) => {
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
      runLocation:   input.runLocation ?? 'vm',
    });
  });

  ipcMain.handle('agent-definitions:update', async(_event, id: string, patch: { name?: string; description?: string; provider?: string; model?: string; prompt?: string; runLocation?: 'vm' | 'container' }) => {
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

  ipcMain.handle('agent-definitions:publish-check', async(_event, slug: string) => {
    try {
      const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
      const { checkAgentManifestForPublish } = await import('@pkg/main/marketplace/publish');

      return checkAgentManifestForPublish(await agentDefinitionService.exportManifest(slug));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('agent-definitions:publish', async(_event, slug: string) => {
    try {
      const { publishLocalArtifact } = await import('@pkg/main/marketplace/publish');

      return await publishLocalArtifact({ kind: 'agent', slug });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('agents:list', async(): Promise<AgentsListResponse> => {
    // Gather all four data sources in parallel. Each is wrapped so a
    // failure in one never blocks the others.

    const [agents, heartbeat, jobs, workflowRuns] = await Promise.all([
      fetchAgents(),
      fetchHeartbeat(),
      fetchJobs(),
      fetchWorkflowRuns(),
    ]);

    return { agents, heartbeat, jobs, workflowRuns, updatedAt: Date.now() };
  });

  ipcMain.handle('agents:message-job', async(_event, jobId: string, taskIndex: number, message: string) => {
    if (!jobId || !Number.isInteger(taskIndex) || taskIndex < 0 || !message?.trim()) {
      return { ok: false, error: 'A job, task, and message are required.' };
    }
    const { sendJobMessage } = await import('@pkg/agent/tools/agents/send_job_message');
    const result = await sendJobMessage({ jobId, taskIndex, message: message.trim() });
    return { ok: result.successBoolean, error: result.successBoolean ? undefined : result.responseString };
  });

  ipcMain.handle('agents:stop-job', async(_event, jobId: string) => {
    if (!jobId) return { ok: false, error: 'A job is required.' };
    const { stopAgentJob } = await import('@pkg/agent/tools/agents/stop_agent_job');
    const result = await stopAgentJob(jobId);
    return { ok: result.successBoolean, error: result.successBoolean ? undefined : result.responseString };
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

  ipcMain.handle('agents:thread-jobs', async(_event, parentThreadId: string): Promise<ThreadAgentCard[]> => {
    if (!parentThreadId || typeof parentThreadId !== 'string') return [];
    return fetchThreadAgentCards(parentThreadId);
  });

  // "Open in tab": show a running hidden child's thread as a chat tab.
  ipcMain.handle('agents:open-job-in-tab', async(_event, jobId: string, parentThreadId: string, taskIndex: number): Promise<boolean> => {
    if (!jobId || !parentThreadId || typeof jobId !== 'string' || typeof parentThreadId !== 'string' || !Number.isInteger(taskIndex)) return false;
    const [{ promoteJobTaskToTab }, { markTaskPromoted }] = await Promise.all([
      import('@pkg/agent/services/AgentTabOpener'),
      import('@pkg/agent/tools/agents/jobRegistry'),
    ]);
    const opened = await promoteJobTaskToTab({ jobId, taskIndex, parentThreadId });
    if (opened) await markTaskPromoted(jobId, taskIndex);
    return opened;
  });

  ipcMain.handle('agents:dismiss-thread-job', async(_event, jobId: string, parentThreadId: string, taskIndex: number): Promise<boolean> => {
    if (!jobId || !parentThreadId || typeof jobId !== 'string' || typeof parentThreadId !== 'string' || !Number.isInteger(taskIndex)) return false;
    const { dismissJobTask } = await import('@pkg/agent/tools/agents/jobRegistry');
    return dismissJobTask(jobId, parentThreadId, taskIndex);
  });
}

export async function fetchThreadAgentCards(parentThreadId: string): Promise<ThreadAgentCard[]> {
  const [{ getJobsForParentThread }, { ConversationHistoryModel }, { resolveSullaLogsDir }, { RunActivity }] = await Promise.all([
    import('@pkg/agent/tools/agents/jobRegistry'),
    import('@pkg/agent/database/models/ConversationHistoryModel'),
    import('@pkg/agent/utils/sullaPaths'),
    import('@pkg/agent/services/RunActivity'),
  ]);
  const jobs = await getJobsForParentThread(parentThreadId);
  const logsDir = resolveSullaLogsDir();
  const cards = await Promise.all(jobs.flatMap(job => job.tasks.map(async(task, taskIndex): Promise<ThreadAgentCard | null> => {
    if (task.dismissed) return null;
    const isTab = task.visibility === 'tab' || job.visibility === 'tab' || task.promotedToTab === true;
    let lastActivity = task.status === 'queued' ? 'Waiting to start' : isTab ? 'Working in its own tab' : 'Starting…';
    let lastActivityAt = RunActivity.lastActivityAt(job.jobId) ?? task.startedAt ?? job.createdAt;

    if (task.threadId) {
      const row = await ConversationHistoryModel.getById(task.threadId);
      if (row) {
        const log = await readConversationLog(row.log_file, logsDir);
        const latest = log.entries.at(-1);
        if (latest) {
          const text = latest.text.replace(/\s+/g, ' ').trim();
          lastActivity = latest.kind === 'tool'
            ? `${ latest.toolName || 'Tool' }: ${ text || 'running' }`
            : text || lastActivity;
          const ts = new Date(latest.ts).getTime();
          if (Number.isFinite(ts)) lastActivityAt = ts;
        }
      }
    }

    const taskStatus = toCardStatus(task.status, job.status);
    if (taskStatus === 'done' && (lastActivity === 'Starting…' || lastActivity === 'Working in its own tab')) lastActivity = task.returnedAt ? `Returned ${ task.contract?.name ?? 'result' }` : 'Finished';
    if (taskStatus === 'failed' && job.error) lastActivity = job.error;

    return {
      jobId: job.jobId,
      taskIndex,
      agentId: task.agentId,
      label: task.label,
      status: taskStatus,
      createdAt: task.startedAt ?? job.createdAt,
      finishedAt: task.finishedAt ?? job.finishedAt,
      conversationId: task.threadId,
      lastActivity: clipLine(lastActivity),
      lastActivityAt,
      kind: isTab
        ? 'tab'
        : 'job',
      contract: task.contract?.name ?? 'result',
      ...(isTab && task.threadId
        ? {
            agentTab: {
              contractId: job.visibility === 'tab'
                ? job.jobId
                : `${ job.jobId }#${ taskIndex }`,
              threadId:      task.threadId,
              agentName:     task.label || task.agentId,
              parentAgentId: job.parentAgentId || job.parentChannel || '',
              depth:         Number(task.depth) || 1,
            },
          }
        : {}),
    };
  })));

  return cards.filter((card): card is ThreadAgentCard => card !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a.taskIndex - b.taskIndex);
}

function clipLine(text: string, max = 180): string {
  return text.length > max ? `${ text.slice(0, max) }…` : text;
}

function toCardStatus(taskStatus: string, jobStatus: string): ThreadAgentCard['status'] {
  if (taskStatus === 'completed') return 'done';
  if (taskStatus === 'error' || taskStatus === 'blocked' || jobStatus === 'failed') return 'failed';
  if (taskStatus === 'stopped' || jobStatus === 'stopped') return 'stopped';
  return 'running';
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
        agentId:      a.agentId,
        name:         a.name || a.agentId,
        channel:      a.channel,
        role:         a.role,
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
    const [
      { getAllJobs },
      { AgentJobMessagingModel },
      { ConversationHistoryModel },
      { resolveSullaLogsDir },
      { RunActivity },
      { GraphRegistry },
      { agentDefinitionService },
    ] = await Promise.all([
      import('@pkg/agent/tools/agents/jobRegistry'),
      import('@pkg/agent/database/models/AgentJobMessagingModel'),
      import('@pkg/agent/database/models/ConversationHistoryModel'),
      import('@pkg/agent/utils/sullaPaths'),
      import('@pkg/agent/services/RunActivity'),
      import('@pkg/agent/services/GraphRegistry'),
      import('@pkg/agent/services/AgentDefinitionService'),
    ]);
    const allJobs = await getAllJobs();
    const definitions = await agentDefinitionService.list();
    const modelByAgent = new Map(definitions.map(definition => [
      definition.slug,
      definition.model || definition.provider || undefined,
    ]));
    const logsDir = resolveSullaLogsDir();

    return Promise.all(allJobs.map(async job => {
      const telemetry = await AgentJobMessagingModel.telemetryForJob(job.jobId);
      const parent = job.parentThreadId ? await ConversationHistoryModel.getById(job.parentThreadId) : null;
      const tasks = await Promise.all(job.tasks.map(async(task, taskIndex) => {
        const latestCheckin = telemetry[taskIndex]?.latestCheckin ?? null;
        let lastActivityAt = latestCheckin?.createdAt ?? RunActivity.lastActivityAt(job.jobId) ?? task.startedAt ?? job.createdAt;
        let lastActivity = latestCheckin?.summary || (task.status === 'queued' ? 'Waiting to start' : 'Working');
        if (task.threadId) {
          const row = await ConversationHistoryModel.getById(task.threadId);
          if (row) {
            const log = await readConversationLog(row.log_file, logsDir);
            const latest = log.entries.at(-1);
            if (latest) {
              const text = latest.text.replace(/\s+/g, ' ').trim();
              lastActivity = latest.kind === 'tool'
                ? `${ latest.toolName || 'Tool' }: ${ text || 'running' }`
                : text || lastActivity;
              const time = new Date(latest.ts).getTime();
              if (Number.isFinite(time)) lastActivityAt = Math.max(lastActivityAt, time);
            }
          }
        }
        if (task.status === 'error' || task.status === 'blocked') lastActivity = task.summary || job.error || lastActivity;
        const state = task.threadId ? GraphRegistry.get(task.threadId)?.state : undefined;

        const kind = task.visibility === 'tab' || job.visibility === 'tab' || task.promotedToTab
          ? 'tab' as const
          : 'job' as const;
        const serializedCheckin = latestCheckin
          ? {
              step: latestCheckin.step,
              summary: latestCheckin.summary,
              blockers: latestCheckin.blockers,
              percent: latestCheckin.percent,
              createdAt: latestCheckin.createdAt,
            }
          : null;

        return {
          taskIndex,
          agentId: task.agentId,
          label: task.label || task.agentId,
          taskId: task.taskId,
          status: task.status,
          threadId: task.threadId,
          startedAt: task.startedAt ?? job.createdAt,
          finishedAt: task.finishedAt,
          depth: Number(task.depth) || 1,
          kind,
          model: modelByAgent.get(task.agentId),
          lastActivity: clipLine(lastActivity),
          lastActivityAt,
          waitingForHuman: state?.metadata?.waitingForUser === true,
          latestCheckin: serializedCheckin,
        };
      }));

      return {
        jobId: job.jobId,
        status: job.status,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        taskCount: job.taskCount,
        error: job.error,
        parentChannel: job.parentChannel,
        parentThreadId: job.parentThreadId,
        parentAgentId: job.parentAgentId,
        parentTitle: parent?.title || undefined,
        tasks,
      };
    }));
  } catch {
    return [];
  }
}

async function fetchWorkflowRuns(): Promise<AgentsListResponse['workflowRuns']> {
  try {
    const { postgresClient } = await import('@pkg/agent/database/PostgresClient');
    const rows = await postgresClient.queryAll<any>(`
      SELECT e.execution_id, e.workflow_id, e.workflow_name, e.workflow_slug, e.status,
             e.started_at, e.updated_at, e.error,
             latest.node_id, latest.payload
        FROM workflow_executions e
        LEFT JOIN LATERAL (
          SELECT node_id, payload
            FROM workflow_execution_events
           WHERE execution_id = e.execution_id
           ORDER BY id DESC LIMIT 1
        ) latest ON true
       WHERE e.status IN ('running', 'suspended', 'failed')
         AND (e.status <> 'failed' OR e.updated_at >= NOW() - INTERVAL '1 hour')
       ORDER BY e.started_at ASC`);

    return rows.map((row: any) => ({
      executionId: row.execution_id,
      workflowId: row.workflow_id,
      name: row.workflow_name || row.workflow_slug || row.workflow_id,
      slug: row.workflow_slug || row.workflow_id,
      status: row.status,
      startedAt: new Date(row.started_at).getTime(),
      updatedAt: new Date(row.updated_at).getTime(),
      activity: row.node_id ? `Step ${ row.node_id }` : row.status === 'suspended' ? 'Paused' : row.status === 'failed' ? 'Failed' : 'Running',
      progress: typeof row.payload?.percent === 'number' ? row.payload.percent : undefined,
      error: row.error || undefined,
    }));
  } catch {
    return [];
  }
}
