// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Opens a delegated child as a visible chat tab. This is the one extra step a
 * `visibility: "tab"` job takes over a hidden one: spawn_agent creates the job
 * and the contract, then calls openAgentTab to prime the child thread, open the
 * renderer tab, wait for it to subscribe, and send the brief as its first turn.
 *
 * The child then runs as a normal desktop chat. Ending a turn does not finish
 * it; only return_result (or a stop) closes the job. stopAgentTab is the tab
 * half of stop_agent_job.
 */

import { applyThreadAgentRoute, SULLA_DESKTOP_CHANNEL_ID, type RoutableAgent } from './ChatAgentRouting';
import { AgentOrchestratorMessageFormatter } from './AgentOrchestratorMessageFormatter';
import { GraphRegistry } from './GraphRegistry';
import { getWebSocketClientService } from './WebSocketClientService';
import { installWorkerRoute } from './WorkerModelRouting';
import { loadThreadState, saveThreadState } from '../nodes/ThreadStateStore';
import { getJob, type AgentJob } from '../tools/agents/jobRegistry';
import { resolveLaunchModelPrecedence, type ModelDecision } from '../languagemodels/modelPrecedence';
import { modelRouter } from '../languagemodels/modelRouter';

import { getActiveAgentWindow } from '@pkg/window/agentWindows';

import type { WorkerModelRoute } from '../languagemodels/workerModelBindings';

const READINESS_TIMEOUT_MS = 10_000;
const readinessWaiters = new Map<string, { threadId: string; finish: (ready: boolean) => void }>();

function waitForRenderer(contractId: string, threadId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readinessWaiters.delete(contractId);
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), READINESS_TIMEOUT_MS);

    readinessWaiters.set(contractId, { threadId, finish });
  });
}

export function acknowledgeAgentTabReady(contractId: string, threadId: string): boolean {
  const waiter = readinessWaiters.get(contractId);
  if (!waiter || waiter.threadId !== threadId) return false;
  waiter.finish(true);
  return true;
}

export function cancelAgentTabReadiness(contractId: string): void {
  readinessWaiters.get(contractId)?.finish(false);
}

/**
 * A tab's contract id is its job id; a hidden child opened in a tab uses
 * `<jobId>#<taskIndex>`. Only the thread that job task owns may hydrate.
 */
export async function getAgentTabThreadSnapshot(contractId: string, threadId: string): Promise<{ messages: any[] }> {
  const [jobId, index] = contractId.split('#');
  const job = await getJob(jobId);
  if (job?.tasks[Number(index ?? 0) || 0]?.threadId !== threadId) return { messages: [] };

  const state = GraphRegistry.get(threadId)?.state ?? await loadThreadState(threadId);
  return { messages: Array.isArray(state?.messages) ? state.messages : [] };
}

function sendAgentCommand(payload: Record<string, unknown>): boolean {
  const agentWindow = getActiveAgentWindow();
  if (!agentWindow) return false;
  const dispatch = () => agentWindow.webContents.send('agent-command', payload);
  if (agentWindow.webContents.isLoading()) agentWindow.webContents.once('did-finish-load', dispatch);
  else dispatch();
  return true;
}

function emitProactive(channel: string, threadId: string, headline: string, body: string, agentReporting: 'brief' | 'standard'): void {
  getWebSocketClientService().send(channel, {
    type: 'chat_message',
    data: {
      threadId,
      kind: 'proactive',
      agentReporting,
      role: 'assistant',
      headline,
      body,
      content: body,
    },
  });
}

export interface OpenAgentTabInput {
  jobId:             string;
  childThreadId:     string;
  childAgent:        RoutableAgent;
  title:             string;
  parentThreadId:    string;
  parentAgentId:     string;
  parentAgentName:   string;
  depth:             number;
  focus:             boolean;
  /** Full first-turn message: brief plus contract footer. */
  prompt:            string;
  /** Dead-run keys the child's activity must touch. */
  activityKeys:      string[];
  workerModelRoute?: WorkerModelRoute;
  modelDecision?: ModelDecision;
  modelOverride?: { provider: string; model: string; connections?: Record<string, string> };
  workflowStep?: import('../../shared/productOwnerWorkflow').DelegatedWorkflowStep;
  providerCliSnapshot?: import('../../shared/providerCliSelection').ProviderCliSnapshot;
  runOverrides?: { model?: string; provider?: string; effort?: string; runLocation?: 'vm' | 'container' };
}

/** Prime the child thread, open its tab and dispatch the brief. Throws on failure. */
export async function openAgentTab(input: OpenAgentTabInput): Promise<void> {
  const { state } = await GraphRegistry.getOrCreateAgentGraph(input.childAgent.graphAgentId, input.childThreadId);
  applyThreadAgentRoute(state, input.childAgent);
  const meta = state.metadata as any;
  const precedence = resolveLaunchModelPrecedence({ override: input.runOverrides, workerModelRoute: input.workerModelRoute });
  installWorkerRoute(state, precedence.workerModelRoute, { jobId: input.jobId, taskIndex: 0 });
  meta.agent = { ...(meta.agent ?? {}), ...Object.fromEntries(Object.entries(input.runOverrides ?? {}).filter(([, value]) => value !== undefined)) };
  if (precedence.step === 'override') await modelRouter.resolve('agents', precedence.choice).catch(() => {
    const requested = precedence.requested!;
    throw new Error(`Requested model ${ requested.provider }/${ requested.model } is not available (not connected or unknown); refusing to run a different model.`);
  });
  meta.modelDecision = input.modelDecision ?? { requested: precedence.requested, ran: null, step: precedence.step, ...(precedence.reason ? { reason: precedence.reason } : {}) };
  if (input.modelOverride) meta.modelOverride = input.modelOverride;
  else delete meta.modelOverride;
  meta.modelDecisionTask = { jobId: input.jobId, taskIndex: 0, generation: 1, threadId: input.childThreadId };
  meta.activityKeys = input.activityKeys;
  meta.delegatedJobId = input.jobId;
  meta.delegatedTaskIndex = 0;
  meta.productOwnerWorkflowStep = input.workflowStep;
  if (input.providerCliSnapshot) meta.providerCliSnapshot = input.providerCliSnapshot;
  await saveThreadState(state);

  const rendererReady = waitForRenderer(input.jobId, input.childThreadId);
  const opened = sendAgentCommand({
    command:         'open-agent-chat-tab',
    threadId:        input.childThreadId,
    agentId:         input.childAgent.agentId,
    agentName:       input.childAgent.name,
    title:           input.title,
    parentThreadId:  input.parentThreadId,
    parentAgentId:   input.parentAgentId,
    parentAgentName: input.parentAgentName,
    contractId:      input.jobId,
    depth:           input.depth,
    focus:           input.focus,
  });
  if (!opened) {
    cancelAgentTabReadiness(input.jobId);
    throw new Error('Sulla Desktop renderer is not available, so the agent tab could not be opened.');
  }

  // Tabs normally mount at once, so this resolves as soon as the tab's
  // desktop-channel adapter subscribes. If the renderer is slow, dispatch
  // after the timeout; the tab hydrates from the saved thread when it mounts.
  await rendererReady;
  emitProactive(SULLA_DESKTOP_CHANNEL_ID, input.childThreadId, `Launched by ${ input.parentAgentName }`, input.prompt, 'standard');
  await getWebSocketClientService().send(SULLA_DESKTOP_CHANNEL_ID, {
    type: 'user_message',
    data: {
      threadId: input.childThreadId,
      content:  input.prompt,
      metadata: {
        agentId:        input.childAgent.graphAgentId,
        source:         'agent_tab_brief',
        inputSource:    'system',
        contractId:     input.jobId,
        jobId:          input.jobId,
        parentThreadId: input.parentThreadId,
      },
    },
  });
}

/**
 * Open a running hidden child's thread in a chat tab ("Open in tab"). The
 * hidden runner keeps driving it; the tab is a live view the human can join.
 */
export async function promoteJobTaskToTab(input: {
  jobId:          string;
  taskIndex:      number;
  parentThreadId: string;
}): Promise<boolean> {
  const job = await getJob(input.jobId);
  if (!job || job.parentThreadId !== input.parentThreadId) return false;
  return openHiddenTaskTab(job, input.taskIndex, true);
}

/**
 * Show an already-running task's own thread in a visible tab. No restart and no
 * new brief: the tab binds to the existing threadId, so its history is the
 * task's history. The renderer reuses one tab per contractId, so reopening is
 * idempotent. Returns false when the task has no thread or the renderer is gone.
 */
export function openHiddenTaskTab(job: AgentJob, taskIndex: number, focus: boolean): boolean {
  const task = job.tasks[taskIndex];
  if (!task?.threadId) return false;
  return sendAgentCommand({
    command:         'open-agent-chat-tab',
    threadId:        task.threadId,
    agentId:         task.agentId,
    agentName:       task.label || task.agentId,
    title:           task.label || task.agentId,
    parentThreadId:  job.parentThreadId ?? '',
    parentAgentId:   job.parentAgentId || job.parentChannel || '',
    parentAgentName: job.parentAgentId || job.parentChannel || 'parent agent',
    contractId:      job.visibility === 'tab' ? job.jobId : `${ job.jobId }#${ taskIndex }`,
    depth:           Number(task.depth) || 1,
    focus,
  });
}

/** Deliver a parent message to a tab child: steers a live run, else starts a turn. */
export async function messageAgentTab(threadId: string, agentId: string, message: string, meta: Record<string, unknown>): Promise<void> {
  await getWebSocketClientService().send(SULLA_DESKTOP_CHANNEL_ID, {
    type: 'inject_message',
    data: {
      threadId,
      content:  new AgentOrchestratorMessageFormatter().format(message, String(meta.jobMessageKind ?? '')),
      metadata: {
        agentId,
        source:      'orchestrator_job_message',
        inputSource: 'system',
        ...meta,
      },
    },
  });
}

/** Stop a tab child's in-flight turn and tell the human why the tab went quiet. */
export async function stopAgentTab(threadId: string, reason: string): Promise<void> {
  const ws = getWebSocketClientService();
  await ws.send(SULLA_DESKTOP_CHANNEL_ID, { type: 'stop_run', data: { threadId } });
  emitProactive(SULLA_DESKTOP_CHANNEL_ID, threadId, 'Stopped by the parent agent', reason, 'brief');
}

/** Tell a tab child its return landed. */
export function confirmAgentTabReturn(threadId: string, contractName: string): void {
  emitProactive(SULLA_DESKTOP_CHANNEL_ID, threadId, 'Contract returned', `Returned ${ contractName } to the parent chat.`, 'brief');
}
