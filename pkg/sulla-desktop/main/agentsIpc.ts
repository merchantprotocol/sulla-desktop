// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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

import { app, ipcMain } from 'electron';
import { agentJobProvider } from '@pkg/agent/app/Providers/AgentJobServiceProvider';
import { AgentRuntimeLiveness } from '@pkg/agent/app/Services/AgentRuntimeLiveness';
import { AgentStateProjector } from '@pkg/agent/app/Services/AgentStateProjector';
import { ParentStallNoticeService } from '@pkg/agent/app/Services/ParentStallNoticeService';
import { completionInboxStore } from '@pkg/agent/services/AgentCompletionInbox';
import { PendingDecisionRepository } from '@pkg/agent/repositories/PendingDecisionRepository';
import { postgresClient } from '@pkg/agent/database/PostgresClient';
import { AgentLivenessReconciler } from '@pkg/agent/app/Services/AgentLivenessReconciler';
import { GraphRegistry } from '@pkg/agent/services/GraphRegistry';
import { configureAgentContainerRuntimeSupervisor, probeAgentContainerRuntime, rehydrateAgentContainerRuntimes } from '@pkg/agent/services/AgentContainerRuntimeRegistry';
import { RuntimeRehydrationCoordinator } from '@pkg/agent/services/RuntimeRehydrationCoordinator';
import { AgentShutdownController } from '@pkg/agent/services/AgentShutdownController';
import { GuestAgentContainerRuntimeSupervisor } from '@pkg/agent/services/AgentContainerLauncher';
import { AgentStatePublisher } from './AgentStatePublisher';
import { StrandedManagerLifecycle } from '@pkg/agent/app/Services/StrandedManagerLifecycle';

import { readConversationLog, readConversationPreview, type AgentConversationEntry, type AgentConversationLogIdentity } from './agentConversationLog';

import { tierEntries } from '@pkg/agent/languagemodels/agentModelTiers';
import { DEFAULT_AGENT_RUN_LOCATION } from '@pkg/agent/database/models/AgentDefinitionModel';
import type { ActiveAgent } from '@pkg/agent/services/ActiveAgentsRegistry';
import { getDatabaseReadGuard } from './DatabaseReadGuard';
import { debugErrorService } from './DebugErrorService';
import {
  validateAgentDefinitionId,
  validateAgentEditorCreateInput,
  validateAgentEditorPatch,
} from './agentEditorContract';
import type { AgentDefinitionPatch } from '@pkg/agent/database/models/AgentDefinitionModel';

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
  modelSlot:          import('@pkg/agent/database/models/AgentDefinitionModel').AgentModelSlot | null;
  modelChoice:        import('@pkg/agent/languagemodels/modelRoutingTypes').AgentModelChoice;
  prompt:             string;
  sourceKind:         string;
  marketplaceVersion: string | null;
  status:             string;
  enabled:            boolean;
  runLocation:        'vm' | 'container';
  /** Directory card fields (migration 0110_add_agent_directory_fields). */
  whenToCall:         string;
  whenNotToCall:      string;
  send:               string;
  returns:            string;
  costTier:           import('@pkg/agent/database/models/AgentDefinitionModel').AgentCostTier | null;
  canCall:            string[];
  isBuiltin:          boolean;
  frontDoor:          boolean | null;
  allowedTools:       string[];
  skillRefs:          string[];
  routineRefs:        string[];
  updatedAt:          string;
  /** config.type ('lead' | 'planner' | 'worker' | 'designer' | ...): the other half of the Manager/Worker split, alongside canCall. */
  type:               string | null;
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
  logIdentity?: AgentConversationLogIdentity;
  truncated:    boolean;
  missingLog:   boolean;
}

export interface ThreadAgentCard {
  jobId:          string;
  taskIndex:      number;
  agentId:        string;
  label:          string;
  status:         'running' | 'parked' | 'done' | 'failed' | 'stopped';
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

// The reconciler's container probes, kept so a quiet agent can read "still running" or "stopped responding".
const agentRuntimeLiveness = new AgentRuntimeLiveness();
const agentStateProjector = new AgentStateProjector(agentJobProvider.states, {
  latest: async(jobId, taskIndex) => (await agentJobProvider.messaging.latestTelemetryForJobs([jobId]))[jobId]?.[taskIndex]?.latestCheckin ?? null,
  // One batched read per snapshot instead of one telemetry query pair per task.
  latestForJobs: async(jobIds) => {
    const telemetry = await agentJobProvider.messaging.latestTelemetryForJobs(jobIds);
    return Object.fromEntries(Object.entries(telemetry).map(([jobId, tasks]) =>
      [jobId, Object.fromEntries(Object.entries(tasks).map(([index, item]) => [index, item.latestCheckin]))]));
  },
  answeredForJobs: async(jobIds) => {
    const telemetry = await agentJobProvider.messaging.latestTelemetryForJobs(jobIds);
    return Object.fromEntries(Object.entries(telemetry).map(([jobId, tasks]) =>
      [jobId, Object.fromEntries(Object.entries(tasks).map(([index, item]) => [index, item.lastMessageDeliveredAt ?? null]))]));
  },
}, Date.now, {}, agentJobProvider.activity, agentRuntimeLiveness);
const stallDecisions = new PendingDecisionRepository(postgresClient);
const parentStallNotices = new ParentStallNoticeService({
  jobs: () => agentJobProvider.jobs.liveJobs(),
  job: jobId => agentJobProvider.jobs.job(jobId),
  telemetry: jobIds => agentJobProvider.messaging.latestTelemetryForJobs(jobIds),
  waitingForDecision: async threadId => await stallDecisions.hasPendingForConversation(threadId)
    || GraphRegistry.get(threadId)?.state.metadata.waitingForUser === true,
}, agentStateProjector, completionInboxStore);
const agentLivenessReconciler = new AgentLivenessReconciler(agentJobProvider.states, {
  graph: task => Boolean(task.threadId && GraphRegistry.get(task.threadId)),
  container: (task) => {
    if (task.runLocation !== 'container') return Promise.resolve(false);
    const alive = probeAgentContainerRuntime(undefined, task.threadId);
    agentRuntimeLiveness.record(task.threadId, alive);
    return Promise.resolve(alive);
  },
  lastCheckin: (jobId, taskIndex) => agentJobProvider.messaging.latestCheckinAt(jobId, taskIndex),
}, agentJobProvider.activity);
const agentStatePublisher = new AgentStatePublisher(agentJobProvider.states, agentStateProjector);
const strandedManagerLifecycle = new StrandedManagerLifecycle(agentJobProvider.stranded, app);

/** `strict` callers are told when the database is unreachable instead of receiving an empty list. */
export interface AgentDefinitionsListOptions { strict?: boolean }
export const AGENT_DEFINITIONS_UNAVAILABLE = 'Agent definitions are temporarily unavailable while the database reconnects.';

export async function listAgentDefinitions(options: AgentDefinitionsListOptions = {}): Promise<AgentDefinitionResponse[]> {
  const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
  // [] while the database is still starting; Studio Agents reloads on `database:available`.
  // A strict caller keeping a loaded catalog gets an error instead, never a false empty list.
  const strict = options?.strict === true;
  const definitions = await getDatabaseReadGuard().run<Awaited<ReturnType<typeof agentDefinitionService.list>> | null>('agent-definitions:list', () => agentDefinitionService.list(), strict ? null : []);
  if (definitions === null) throw new Error(AGENT_DEFINITIONS_UNAVAILABLE);
  return definitions.filter(a => a.status !== 'archive').map(a => ({
    id:                 a.id,
    slug:               a.slug,
    name:               a.name,
    description:        a.description,
    provider:           a.provider,
    model:              a.model,
    modelSlot:          a.model_slot,
    modelChoice:        a.model_choice ?? (a.provider && a.model ? { mode: 'pin', provider: a.provider, model: a.model } : { mode: 'list' }),
    prompt:             a.prompt_content,
    sourceKind:         a.source_kind,
    marketplaceVersion: a.marketplace_version,
    status:             a.status,
    enabled:            a.enabled,
    runLocation:        a.run_location,
    whenToCall:         a.when_to_call,
    whenNotToCall:      a.when_not_to_call,
    send:               a.send,
    returns:            a.returns,
    costTier:           a.cost_tier,
    canCall:            a.can_call,
    isBuiltin:          a.is_builtin,
    frontDoor:          a.front_door,
    allowedTools:       [...(a.allowed_tools ?? [])],
    skillRefs:          [...(a.skill_refs ?? [])],
    routineRefs:        [...(a.routine_refs ?? [])],
    updatedAt:          toIso(a.updated_at),
    type:               typeof a.config?.type === 'string' ? a.config.type : null,
  }));
}

export function initAgentsIpc(): void {
  // Do not decide a container is gone until fail-closed inventory completes. Every state read awaits this same readiness promise.
  configureAgentContainerRuntimeSupervisor(new GuestAgentContainerRuntimeSupervisor(undefined, { resolve: async(jobId, taskIndex) => {
    const task = (await agentJobProvider.states.jobForWrite(jobId))?.tasks[taskIndex];
    return task ? { subject: `legacy:${ task.agentId }`, deviceId: 'legacy-rehydrated', agentId: task.agentId, threadId: task.threadId } : undefined;
  } }));
  const runtimeRehydration = new RuntimeRehydrationCoordinator(rehydrateAgentContainerRuntimes, () => agentLivenessReconciler.reconcile());
  agentLivenessReconciler.setReadinessRecovery(runtimeRehydration);
  agentJobProvider.states.setReadiness(() => runtimeRehydration.ready());
  runtimeRehydration.start();
  agentLivenessReconciler.start();
  strandedManagerLifecycle.start();
  completionInboxStore.registerStallValidator((channel, threadId, entry) => parentStallNotices.canDeliver(channel, threadId, entry));
  parentStallNotices.start();
  app.once('before-quit', () => parentStallNotices.stop());
  new AgentShutdownController(runtimeRehydration, agentLivenessReconciler).register(app);
  agentStatePublisher.register();
  ipcMain.handle('agent-definitions:list', (_event, options?: AgentDefinitionsListOptions) => listAgentDefinitions(options));

  ipcMain.handle('agent-definitions:create', async(_event, rawInput: unknown) => {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    const input = validateAgentEditorCreateInput(rawInput);
    if (await agentDefinitionService.findBySlug(input.slug)) {
      throw new Error(`An agent with slug "${ input.slug }" already exists.`);
    }
    const candidates = input.modelTiers ? tierEntries(input.modelTiers).map(row => row.candidate) : input.modelChoice?.mode === 'pin'
      ? [
        {
          provider: input.modelChoice.provider,
          model:    input.modelChoice.model,
          ...(input.modelChoice.effort ? { effort: input.modelChoice.effort } : {}),
        },
        ...input.modelFallbacks,
      ]
      : [];
    const profile = {
      slug:          input.slug,
      name:          input.name,
      description:   input.description,
      provider:      input.provider ?? null,
      modelSlot:     input.modelSlot,
      modelChoice:   input.modelChoice,
      systemPrompt:  input.prompt,
      promptContent: input.prompt,
      promptFiles:   { 'prompt.md': input.prompt },
      allowedTools:  input.allowedTools,
      skillRefs:     input.skillRefs,
      routineRefs:   input.routineRefs,
      whenToCall:    input.whenToCall,
      whenNotToCall: input.whenNotToCall,
      send:          input.send,
      returns:       input.returns,
      costTier:      input.costTier,
      canCall:       input.canCall,
      frontDoor:     input.frontDoor,
      status:        'production' as const,
      sourceKind:    'local' as const,
      runLocation:   input.runLocation ?? DEFAULT_AGENT_RUN_LOCATION,
    };
    if (candidates.length) {
      const { workerModelRouting } = await import('@pkg/agent/services/WorkerModelRouting');
      // Reject unrepresentable or unavailable pins before either the profile or owner mapping is written.
      await workerModelRouting.validateSubscriptionCandidates(candidates, input.modelTiers ? 100 : 10);
      const created = await agentDefinitionService.create({
        ...profile,
        enabled:       false,
      });
      let binding: { editToken: string; revision: number } | undefined;
      try {
        binding = await workerModelRouting.initializeNewBindingForDefinition(input.slug, created.id, candidates, input.modelTiers);
        const enabled = await agentDefinitionService.update(created.id, { enabled: input.enabled }, created.updated_at);
        if (!enabled) throw new Error('The saved agent disappeared before activation.');
        return { ...enabled, modelBindingReceipt: binding };
      } catch (error) {
        const unchangedProfile = await agentDefinitionService.get(created.id).then(current => current?.updated_at === created.updated_at, () => false);
        const mappingRemoved = unchangedProfile && (binding
          ? await workerModelRouting.removeBindingForDefinition(input.slug, created.id, binding).catch(() => false)
          : await import('@pkg/agent/languagemodels/modelRouter').then(async({ modelRouter }) => {
            const existing = (await modelRouter.getEditableState()).workerBindings?.[input.slug];

            return existing?.agentId !== created.id;
          }).catch(() => false));
        const profileRemoved = mappingRemoved && await agentDefinitionService.delete(created.id).catch(() => false);
        if (!mappingRemoved || !profileRemoved) {
          throw new Error(`The agent was not activated. Its exact profile remains disabled for recovery (${ created.id }); the requested model route could not be saved safely.`);
        }
        throw new Error(`The agent was not created because its requested model could not be activated safely: ${ error instanceof Error ? error.message : String(error) }`);
      }
    }
    return agentDefinitionService.create({
      ...profile,
      enabled:       input.enabled,
    });
  });

  ipcMain.handle('agent-definitions:update', async(_event, rawId: string, rawPatch: unknown) => {
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    const id = validateAgentDefinitionId(rawId);
    const { patch, expectedUpdatedAt } = validateAgentEditorPatch(rawPatch);
    const definitionPatch: AgentDefinitionPatch = {
      ...patch,
      ...(patch.prompt !== undefined ? { systemPrompt: patch.prompt, promptContent: patch.prompt } : {}),
    };
    return agentDefinitionService.update(id, definitionPatch, expectedUpdatedAt);
  });

  ipcMain.handle('agent-definitions:delete', async(_event, rawId: string) => {
    const id = validateAgentDefinitionId(rawId);
    const { agentDefinitionService } = await import('@pkg/agent/services/AgentDefinitionService');
    const removed = await agentDefinitionService.removeFromEditor(id);
    if (!removed) return false;
    if (!removed.archived) {
      const { workerModelRouting } = await import('@pkg/agent/services/WorkerModelRouting');
      await workerModelRouting.removeBindingForDefinition(removed.slug, id).catch(error => {
        console.warn('[AgentsIPC] Could not clean up removed agent model settings:', error);
      });
    }
    return true;
  });

  ipcMain.handle('agent-definitions:export', async(_event, slug: string) => {
    const { exportLocalAgentPackage } = await import('./marketplace/localAgentPackages');
    return exportLocalAgentPackage(slug);
  });

  ipcMain.handle('agent-definitions:import', async(_event, manifest: import('@pkg/agent/services/AgentDefinitionService').AgentMarketplaceManifest) => {
    const { importLocalAgentPackage } = await import('./marketplace/localAgentPackages');
    return importLocalAgentPackage(manifest);
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
    await agentJobProvider.states.ready();
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
    const job = await agentJobProvider.states.jobForWrite(jobId);
    if (!job?.tasks[taskIndex] || !agentJobProvider.states.isLive(job, job.tasks[taskIndex])) return {
      ok: false, stale: true, error: `Job ${ jobId } task ${ taskIndex } is no longer live.`, snapshot: await agentStateProjector.snapshot(),
    };
    const { sendJobMessage } = await import('@pkg/agent/tools/agents/send_job_message');
    const result = await sendJobMessage({ jobId, taskIndex, message: message.trim() });
    return result.successBoolean ? { ok: true } : { ok: false, stale: true, error: result.responseString, snapshot: await agentStateProjector.snapshot() };
  });

  ipcMain.handle('agents:stop-job', async(_event, jobId: string) => {
    if (!jobId) return { ok: false, error: 'A job is required.' };
    const job = await agentJobProvider.states.jobForWrite(jobId);
    if (!job || !job.tasks.some(task => agentJobProvider.states.isLive(job, task))) return {
      ok: false, stale: true, error: `Job ${ jobId } is no longer live.`, snapshot: await agentStateProjector.snapshot(),
    };
    const { stopAgentJob } = await import('@pkg/agent/tools/agents/stop_agent_job');
    const { StopPrincipal } = await import('@pkg/agent/app/ValueObjects/StopPrincipal');
    const result = await stopAgentJob(jobId, StopPrincipal.human(), 'Stopped from Live Agents');
    return result.successBoolean ? { ok: true } : { ok: false, stale: true, error: result.responseString, snapshot: await agentStateProjector.snapshot() };
  });

  ipcMain.handle('agents:kill-tree', async(_event, threadId: string) => {
    if (!threadId) return { ok: false, killedJobs: 0, error: 'A thread is required.' };
    const { agentKillService } = await import('@pkg/agent/services/AgentKillService');
    return agentKillService.killTree(threadId);
  });

  ipcMain.handle('agents:kill-all-switch:get', async() => {
    const { agentKillService } = await import('@pkg/agent/services/AgentKillService');
    return agentKillService.switchState();
  });

  ipcMain.handle('agents:kill-all-switch:set', async(_event, on: boolean) => {
    const { agentKillService } = await import('@pkg/agent/services/AgentKillService');
    return agentKillService.setSwitch(on === true);
  });

  ipcMain.handle('agents:thread-live-children', async(_event, threadId: string) => {
    if (!threadId) return { count: 0 };
    const { agentKillService } = await import('@pkg/agent/services/AgentKillService');
    return { count: await agentKillService.liveDescendantCount(threadId) };
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
    await agentJobProvider.states.ready();
    return fetchThreadAgentCards(parentThreadId);
  });

  // "Open in tab": show a running hidden child's thread as a chat tab.
  ipcMain.handle('agents:open-job-in-tab', async(_event, jobId: string, parentThreadId: string, taskIndex: number): Promise<boolean> => {
    if (!jobId || !parentThreadId || typeof jobId !== 'string' || typeof parentThreadId !== 'string' || !Number.isInteger(taskIndex)) return false;
    const job = await agentJobProvider.states.jobForWrite(jobId);
    if (!job?.tasks[taskIndex] || !agentJobProvider.states.isLive(job, job.tasks[taskIndex])) return false;
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
  const [{ ConversationHistoryModel }, { resolveSullaLogsDir }, { AgentJobMessagingModel }] = await Promise.all([
    import('@pkg/agent/database/models/ConversationHistoryModel'),
    import('@pkg/agent/utils/sullaPaths'),
    import('@pkg/agent/database/models/AgentJobMessagingModel'),
  ]);
  // UI poll (every 3s per open chat): a few seconds of staleness is invisible, a recursive query per poll is not.
  const jobs = await agentJobProvider.states.descendants(parentThreadId, { maxStaleMs: 4_000 });
  const logsDir = resolveSullaLogsDir();
  // Two batched reads for the whole card set instead of per-task telemetry and conversation lookups.
  const [telemetryByJob, conversationById] = await Promise.all([
    AgentJobMessagingModel.latestTelemetryForJobs(jobs.map(job => job.jobId)).catch((error) => {
      void debugErrorService.reportError(`agents:thread-jobs:telemetry:${ parentThreadId }`, error);
      return {} as Awaited<ReturnType<typeof AgentJobMessagingModel.latestTelemetryForJobs>>;
    }),
    ConversationHistoryModel.getByIds(jobs.flatMap(job => job.tasks.flatMap(task => task.threadId ? [task.threadId] : []))),
  ]);
  const cards = await Promise.all(jobs.flatMap(job => job.tasks.map(async(task, taskIndex): Promise<ThreadAgentCard | null> => {
    if (task.dismissed) return null;
    const isTab = task.visibility === 'tab' || job.visibility === 'tab' || task.promotedToTab === true;
    try {
    let lastActivity = task.status === 'parked' ? `Parked · waiting on ${ job.waitingOnChildren ?? 0 } children` : task.status === 'queued' ? 'Waiting to start' : isTab ? 'Working in its own tab' : 'Starting…';
    const checkin = telemetryByJob[job.jobId]?.[taskIndex]?.latestCheckin ?? null;
    const activity = agentJobProvider.activity.project(job, task, taskIndex, checkin, telemetryByJob[job.jobId]?.[taskIndex]?.lastMessageDeliveredAt ?? null);
    const lastActivityAt = activity.lastActivityAt;

    if (task.threadId) {
      const row = conversationById.get(task.threadId);
      if (row) {
        const log = await readConversationLog(row.log_file, logsDir);
        const latest = log.entries.at(-1);
        if (latest) {
          const text = latest.text.replace(/\s+/g, ' ').trim();
          lastActivity = latest.kind === 'tool'
            ? `${ latest.toolName || 'Tool' }: ${ text || 'running' }`
            : text || lastActivity;
        }
      }
    }

    const taskStatus = toCardStatus(activity.state);
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
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void debugErrorService.reportError(`agents:thread-jobs:card:${ job.jobId }#${ taskIndex }`, error);
      return {
        jobId: job.jobId,
        taskIndex,
        agentId: task.agentId,
        label: task.label,
        status: task.status === 'parked' ? 'parked' : task.status === 'completed' ? 'done'
          : task.status === 'stopped' ? 'stopped' : ['error', 'lost', 'blocked'].includes(task.status) ? 'failed' : 'running',
        createdAt: task.startedAt ?? job.createdAt,
        finishedAt: task.finishedAt ?? job.finishedAt,
        conversationId: task.threadId,
        lastActivity: clipLine(`Details unavailable: ${ reason }`),
        lastActivityAt: task.startedAt ?? job.createdAt,
        kind: isTab ? 'tab' : 'job',
        contract: task.contract?.name ?? 'result',
      };
    }
  })));

  return cards.filter((card): card is ThreadAgentCard => card !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a.taskIndex - b.taskIndex);
}

function clipLine(text: string, max = 180): string {
  return text.length > max ? `${ text.slice(0, max) }…` : text;
}

/**
 * Task status, not the job-level rollup, decides a sibling's card: one
 * task parking flips the job's own rollup status to 'parked' only once
 * every task has, so a still-running sibling must never read as parked.
 */
function toCardStatus(state: string): ThreadAgentCard['status'] {
  if (state === 'parked') return 'parked';
  if (state === 'done') return 'done';
  if (state === 'failed' || state === 'lost' || state === 'blocked') return 'failed';
  if (state === 'stopped') return 'stopped';
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
  } catch (error) {
    void debugErrorService.reportError('agents:list:active-agents', error);
    return [];
  }
}

async function fetchHeartbeat(): Promise<AgentsListResponse['heartbeat']> {
  try {
    const { getHeartbeatService } = await import(
      '@pkg/agent/services/HeartbeatService'
    );
    return getHeartbeatService().getStatus();
  } catch (error) {
    void debugErrorService.reportError('agents:list:heartbeat', error);
    return null;
  }
}

async function fetchJobs(): Promise<AgentsListResponse['jobs']> {
  try {
    const [
      { AgentJobMessagingModel },
      { ConversationHistoryModel },
      { resolveSullaLogsDir },
      { GraphRegistry },
      { agentDefinitionService },
    ] = await Promise.all([
      import('@pkg/agent/database/models/AgentJobMessagingModel'),
      import('@pkg/agent/database/models/ConversationHistoryModel'),
      import('@pkg/agent/utils/sullaPaths'),
      import('@pkg/agent/services/GraphRegistry'),
      import('@pkg/agent/services/AgentDefinitionService'),
    ]);
    // Live refreshes need active work only. Batch compact check-ins/messages for
    // all visible jobs instead of issuing two history reads per job per tick.
    // Live shows unfinished jobs plus failures/stops from the last hour (the ones
    // the human watches for). Completed history stays out of the poll.
    const failedCutoff = Date.now() - 60 * 60 * 1000;
    const allJobs = (await agentJobProvider.states.list(100, true)).filter(job => {
      if (job.status === 'completed') return false;
      if (job.status === 'failed' || job.status === 'stopped') return (job.finishedAt ?? job.createdAt) >= failedCutoff;
      return true;
    });
    const telemetryByJob = await AgentJobMessagingModel.latestTelemetryForJobs(allJobs.map(job => job.jobId));
    const definitions = await agentDefinitionService.list();
    const modelByAgent = new Map(definitions.map(definition => [
      definition.slug,
      definition.model_slot || definition.model || definition.provider || undefined,
    ]));
    const logsDir = resolveSullaLogsDir();

    const conversationById = await ConversationHistoryModel.getByIds(allJobs.flatMap(job => [
      ...(job.parentThreadId ? [job.parentThreadId] : []),
      ...job.tasks.flatMap(task => task.threadId ? [task.threadId] : []),
    ]));

    return Promise.all(allJobs.map(async job => {
      try {
      const telemetry = telemetryByJob[job.jobId] ?? {};
      const parent = job.parentThreadId ? conversationById.get(job.parentThreadId) ?? null : null;
      const tasks = await Promise.all(job.tasks.map(async(task, taskIndex) => {
        const latestCheckin = telemetry[taskIndex]?.latestCheckin ?? null;
        const activity = agentJobProvider.activity.project(job, task, taskIndex, latestCheckin, telemetry[taskIndex]?.lastMessageDeliveredAt ?? null);
        const lastActivityAt = activity.lastActivityAt;
        let lastActivity = latestCheckin?.summary || (task.status === 'queued' ? 'Waiting to start' : 'Working');
        if (task.threadId) {
          const row = conversationById.get(task.threadId);
          if (row) {
            const log = await readConversationLog(row.log_file, logsDir);
            const latest = log.entries.at(-1);
            if (latest) {
              const text = latest.text.replace(/\s+/g, ' ').trim();
              lastActivity = latest.kind === 'tool'
                ? `${ latest.toolName || 'Tool' }: ${ text || 'running' }`
                : text || lastActivity;
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
          status: activity.state,
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
      } catch (error) {
        void debugErrorService.reportError(`agents:list:job-enrichment:${ job.jobId }`, error);
        return { jobId: job.jobId, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt, taskCount: job.taskCount, error: job.error, parentChannel: job.parentChannel, parentThreadId: job.parentThreadId, parentAgentId: job.parentAgentId, tasks: [] };
      }
    }));
  } catch (error) {
    void debugErrorService.reportError('agents:list:jobs', error);
    throw error;
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
        LEFT JOIN workflows w ON w.id = e.workflow_id
        LEFT JOIN LATERAL (
          SELECT node_id, payload
            FROM workflow_execution_events
           WHERE execution_id = e.execution_id
           ORDER BY id DESC LIMIT 1
        ) latest ON true
       WHERE e.status IN ('running', 'suspended')
         AND (w.id IS NULL OR w.status <> 'archive')
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
  } catch (error) {
    void debugErrorService.reportError('agents:list:workflow-runs', error);
    return [];
  }
}
