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
import { GraphRegistry } from './GraphRegistry';
import { getWebSocketClientService } from './WebSocketClientService';
import { loadThreadState, saveThreadState } from '../nodes/ThreadStateStore';
import { getJob } from '../tools/agents/jobRegistry';

import { getWindow } from '@pkg/window';

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
  const agentWindow = getWindow('main-agent');
  if (!agentWindow) return false;
  const dispatch = () => agentWindow.webContents.send('agent-command', payload);
  if (agentWindow.webContents.isLoading()) agentWindow.webContents.once('did-finish-load', dispatch);
  else dispatch();
  return true;
}

function emitProactive(channel: string, threadId: string, headline: string, body: string): void {
  getWebSocketClientService().send(channel, {
    type: 'chat_message',
    data: {
      threadId,
      kind: 'proactive',
      role: 'assistant',
      headline,
      body,
      content: body,
    },
  });
}

export interface OpenAgentTabInput {
  jobId:            string;
  childThreadId:    string;
  childAgent:       RoutableAgent;
  title:            string;
  parentThreadId:   string;
  parentAgentId:    string;
  parentAgentName:  string;
  depth:            number;
  focus:            boolean;
  /** Full first-turn message: brief plus contract footer. */
  prompt:           string;
  /** Dead-run keys the child's activity must touch. */
  activityKeys:     string[];
  ownedProjectTaskIds: string[];
}

/** Prime the child thread, open its tab and dispatch the brief. Throws on failure. */
export async function openAgentTab(input: OpenAgentTabInput): Promise<void> {
  const { state } = await GraphRegistry.getOrCreateAgentGraph(input.childAgent.graphAgentId, input.childThreadId);
  applyThreadAgentRoute(state, input.childAgent);
  const meta = state.metadata as any;
  meta.activityKeys = input.activityKeys;
  meta.ownedProjectTaskIds = input.ownedProjectTaskIds;
  meta.delegatedJobId = input.jobId;
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
  emitProactive(SULLA_DESKTOP_CHANNEL_ID, input.childThreadId, `Launched by ${ input.parentAgentName }`, input.prompt);
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
  const task = job?.tasks[input.taskIndex];
  if (!job || !task?.threadId || job.parentThreadId !== input.parentThreadId) return false;
  return sendAgentCommand({
    command:         'open-agent-chat-tab',
    threadId:        task.threadId,
    agentId:         task.agentId,
    agentName:       task.label || task.agentId,
    title:           task.label || task.agentId,
    parentThreadId:  input.parentThreadId,
    parentAgentId:   job.parentAgentId || job.parentChannel || '',
    parentAgentName: job.parentAgentId || job.parentChannel || 'parent agent',
    contractId:      job.visibility === 'tab' ? job.jobId : `${ job.jobId }#${ input.taskIndex }`,
    depth:           Number(task.depth) || 1,
    focus:           true,
  });
}

/** Deliver a parent message to a tab child: steers a live run, else starts a turn. */
export async function messageAgentTab(threadId: string, agentId: string, message: string, meta: Record<string, unknown>): Promise<void> {
  await getWebSocketClientService().send(SULLA_DESKTOP_CHANNEL_ID, {
    type: 'inject_message',
    data: {
      threadId,
      content:  `[Message from orchestrator]\n${ message }`,
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
  emitProactive(SULLA_DESKTOP_CHANNEL_ID, threadId, 'Stopped by the parent agent', reason);
}

/** Tell a tab child its return landed. */
export function confirmAgentTabReturn(threadId: string, contractName: string): void {
  emitProactive(SULLA_DESKTOP_CHANNEL_ID, threadId, 'Contract returned', `Returned ${ contractName } to the parent chat.`);
}
