// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// BackendGraphWebSocketService.ts
// Main-process agent dispatcher: routes messages on the sulla-desktop and
// heartbeat channels to the default agent via GraphRegistry.
import { randomUUID } from 'node:crypto';
import { toolRegistry } from '@pkg/agent/tools/registry';
import { SUPPORT_TOOL_NAMES } from '@pkg/agent/tools/support/manifests';
import { DeferredStallInput } from '../app/Services/DeferredStallInput';
import { CompletionKey } from '../app/Services/CompletionKey';
import { DelegatedCompletionHandoff } from '../app/Services/DelegatedCompletionHandoff';
import { acquireWhenReady, executeWithContainerLifecycleRecovery } from './ContainerLifecycleRecovery';
import { applyThreadAgentRoute, resolveDefaultRouteAgent, SULLA_DESKTOP_CHANNEL_ID, type RoutableAgent } from './ChatAgentRouting';
import { GraphRegistry, getAgentIdForTrigger, nextThreadId, nextMessageId } from './GraphRegistry';
import { InterruptedAgentRecoveryService } from './InterruptedAgentRecoveryService';
import { agentWaitProvider } from './AgentWaitServices';
import { RunActivity } from './RunActivity';
import { agentJobLifecycle, returnedTaskSettlement } from './AgentJobLifecycleService';
import { parkedAgentRehydrator } from './ParkedAgentRehydrator';
import { ChatErrorDiagnostics } from './ChatErrorDiagnostics';
import { getSchedulerService } from './SchedulerService';
import { getWebSocketClientService, type WebSocketMessage } from './WebSocketClientService';
import { ThreadModelOverridePolicy } from './ThreadModelOverridePolicy';
import { settleHiddenAgentRuns } from './HiddenAgentRuns';
import { AbortService } from './AbortService';
import { completionInboxStore, enqueueAgentCompletion, formatCompletionBatch, registerCompletionIdleDispatcher, releaseAgentCompletionClaim, requeueAgentCompletionAfterFailure, requeueAgentCompletionQuietly, setCompletionInboxStopped, takeAgentCompletions, type PendingCompletion } from './AgentCompletionInbox';
import { recoverPendingAgentCompletions } from './AgentCompletionRecoveryService';
import { agentDefinitionService } from './AgentDefinitionService';
import { agentExecutionReadiness, executionAbort, waitForAutomaticAgentExecution } from './AgentExecutionReadiness';
import { acquireChatActivity, releaseChatActivity } from '@pkg/main/SleepPreventionService';
import { loadThreadState, saveThreadState } from '../nodes/ThreadStateStore';
import { awaitSteerAcknowledgements, injectSteer, steerText, takePendingSteers } from '../utils/steerChannel';
import { resolveAgentIdentity } from '../utils/agentIdentity';
import { cleanVoiceTurnId } from '../utils/voiceTurn';
import { cliPinnedModelId } from '../languagemodels/ModelTierResolver';
import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { AgentJobMessagingModel } from '../database/models/AgentJobMessagingModel';
import { AgentInbox, type AgentInboxDeliveryReceipt, type AgentInboxEntry, type AgentInboxRepository, type AgentInboxTarget } from './AgentInbox';
import { PostgresAgentInboxRepository } from '../app/Repositories/PostgresAgentInboxRepository';
import { AmbiguousAgentInboxTargetError, NoAgentInboxTargetError, DurableAgentInboxReceiverResolver, type AgentInboxReceiverResolver } from './AgentInboxReceiverResolver';
import { DesktopPostgresConnection } from '../app/Database/DesktopPostgresConnection';
import { postgresClient } from '../database/PostgresClient';

import { frontendGraphLogger as console } from '@pkg/agent/utils/agentLogger';
import { firstRunTrace } from '@pkg/utils/firstRunTraceSink';
import { DelegatedTurnPreparer } from './DelegatedTurnPreparer';
import { ReceiverRunGuard } from './ReceiverRunGuard';
import { CompletionConsumptionRecorder } from './CompletionConsumptionRecorder';
import { ParentInputWaitRecorder, type ParentInputWaitKind, type ParentInputWaitRecord } from './ParentInputWaitRecorder';
import { SupportSessionPolicy } from './SupportSessionPolicy';
import { DecisionAnswerDelivery, type DecisionAnswerDeliveryInput } from './DecisionAnswerDelivery';
import { workerModelRouting, installWorkerRoute, detachTerminalWorkerChat, isWorkerMappingHumanTurn } from './WorkerModelRouting';
import { ConversationThreadStore } from '../database/models/ConversationThreadStore';
import { AgentTurnStopper } from './AgentTurnStopper';
import { AgentOrchestratorMessageFormatter } from './AgentOrchestratorMessageFormatter';
import { AgentRunLocationResolver } from './AgentRunLocationResolver';
import { DesktopOrgCloudSession } from './CloudOrgMessagingTransport';
import { DesktopOrgMessengerFactory } from './DesktopOrgMessengerFactory';
import { OrgMembershipDirectory, type OrgMembership } from './OrgMembershipDirectory';
import { OrgMessengerFleet } from './OrgMessengerFleet';
import type { OrgConversationStartRequest } from './OrgMessenger';
import type { MessageEnvelope } from '@sulla/domain';
import { OrgContactRequestDecisionPrompter } from './OrgContactRequestDecisionPrompter';
import { PostgresOrgMessagingStateRepository } from '../app/Repositories/PostgresOrgMessagingStateRepository';
import { AgentReadinessStatus } from '@pkg/shared/agentReadinessStatus';
import { HumanSendWaitRecorder, type HumanSendDispatch, type HumanSendPath, type HumanSendRoute } from '@pkg/shared/HumanSend';
import Logging from '@pkg/utils/logging';
import { SystemTurnTimingClock, TurnTiming, TurnTimingDispatchContext, TurnTimingDispatchLifecycle } from './TurnTiming';
import type { TurnTimingOutcome, TurnTimingProvider } from './TurnTiming';

import type { CalendarEventData } from './CalendarClient';
import type { AgentGraphState } from '../nodes/Graph';

const HEARTBEAT_CHANNEL_ID = 'heartbeat';
const RESUME_CONTINUE_DELAY_MS = 1_000;
const CALENDAR_CHANNEL_ID = 'calendar_event';
// Dedicated channel for chats routed from a paired mobile device via the
// Cloudflare relay. Mobile messages arrive through `DesktopRelayClient`,
// which publishes them here as plain `user_message` frames. The agent
// loop picks them up the same way it picks up desktop UI messages —
// same AgentNode/BaseNode pipeline, same XML strip, same tool execution.
// Responses emitted by the agent land back on this channel; the relay
// client subscribes and forwards them up to Cloudflare → mobile.
const MOBILE_RELAY_CHANNEL_ID = 'mobile-relay';

export function mapInboxReceiptToA2aStatus(receipt: AgentInboxDeliveryReceipt | 'delivered' | 'queued' | 'duplicate'): { status: 'delivered' | 'failed'; reason?: string } {
  if (receipt === 'failed') return { status: 'failed', reason: 'delivery failed' };
  if (receipt === 'deferred' || receipt === 'queued') return { status: 'delivered', reason: 'queued' };
  return { status: 'delivered' };
}
const CONVERSATION_CONTAINER_IDLE_MS = 30 * 60_000;
const CONVERSATION_CONTAINER_SWITCH_WAIT_MS = 10 * 60_000;

class ConversationContainerBusyError extends Error {
  constructor() {
    super('A conversation container is still in use by another channel.');
    this.name = 'ConversationContainerBusyError';
  }
}

/**
 * Folder key for a conversation container's workspace and provider homes.
 * A woken hidden delegated thread carries the key its spawn_agent run used
 * (ParkedAgentRehydrator); every chat keeps its channel-scoped key.
 */
export function conversationPersistenceKey(channelId: string, threadId: string, state: AgentGraphState): string {
  const delegatedKey = (state.metadata as any).containerPersistenceKey;
  return typeof delegatedKey === 'string' && delegatedKey ? delegatedKey : `conversation:${ channelId }:${ threadId }`;
}

let backendGraphWebSocketServiceInstance: BackendGraphWebSocketService | null = null;

export function getBackendGraphWebSocketService(): BackendGraphWebSocketService {
  if (!backendGraphWebSocketServiceInstance) {
    if (agentExecutionReadiness.draining) throw executionAbort();
    backendGraphWebSocketServiceInstance = new BackendGraphWebSocketService();
  }
  return backendGraphWebSocketServiceInstance;
}

export function drainAgentExecution(): Promise<void> {
  agentExecutionReadiness.close();
  const current = backendGraphWebSocketServiceInstance;
  return (current?.drain() ?? Promise.resolve()).finally(() => {
    if (backendGraphWebSocketServiceInstance === current) backendGraphWebSocketServiceInstance = null;
  });
}

export class BackendGraphWebSocketService {
  private readonly orchestratorMessageFormatter = new AgentOrchestratorMessageFormatter();
  private readonly runLocationResolver = new AgentRunLocationResolver();
  private readonly wsService = getWebSocketClientService();
  private readonly schedulerService = getSchedulerService();
  private unsubscribes: (() => void)[] = [];
  // Keyed by `${channelId}|${threadId}` so concurrent threads on the same
  // channel (e.g. multiple chat tabs sharing the desktop WebSocket) can
  // run in parallel. Previously this was keyed by channelId alone, which
  // made every new tab message abort the prior tab's still-running graph.
  private activeAborts = new Map<string, AbortService>();
  /** Bounded, per-service idempotency ledger for renderer human sends. */
  private readonly humanSendReceipts = new Map<string, { threadId: string; route: HumanSendRoute; path?: HumanSendPath }>();
  private readonly cancelledHumanSends = new Set<string>();
  private readonly humanSendInFlight = new Set<string>();
  private readonly humanSendWaitRecorder = new HumanSendWaitRecorder(line => Logging.perf.log(line));
  private suspendedRuns = new Set<string>();
  private readonly relayRuns = new Map<string, { id: string; controller: AbortController }>();
  private readonly readinessWaits = new Map<string, Set<AbortController>>();
  private readonly dispatchedRuns = new Set<Promise<unknown>>();
  private readonly recoveryAbort = new AbortController();
  private recoveryStarted = false;
  private readonly recoveryCutoff = Date.now();
  private readonly agentInbox: AgentInbox;
  private readonly parentInputWaitRecorder = new ParentInputWaitRecorder();
  private readonly activeCompletionConsumptions = new Map<string, CompletionConsumptionRecorder>();
  private decisionAnswerRetry?:           ReturnType<typeof setTimeout>;
  private decisionAnswerRetrying = false;
  private decisionAnswerGeneration = 0;
  private readonly inboxReceiverResolver: AgentInboxReceiverResolver;
  private readonly inboxRunGuard: ReceiverRunGuard;
  private readonly orgMessengerFleet: OrgMessengerFleet;
  private orgMessagingAbort?: AbortController;

  /** The fallback supports prototype-only characterization harnesses that intentionally skip constructor side effects. */
  private prepareFreshTurn(state: AgentGraphState): void {
    (this.turnPreparer ?? new DelegatedTurnPreparer()).prepare(state);
  }
  private resumeContexts = new Map<string, {
    channelId: string; triggerType: string; threadId: string; scopedWorkflowId?: string;
    overrideAgentId?: string; inputSource?: string;
  }>();
  private subscribedChannels = new Set<string>();
  private conversationContainers = new Map<string, {
    workerMappingKey?: string;
    provider: string;
    model?: string;
    providerCliSnapshot?: import('@pkg/shared/providerCliSelection').ProviderCliSnapshot;
    agentId: string;
    lifecycle:         import('./AgentContainerLauncher').AgentContainerLifecycle;
    idleTimer:         ReturnType<typeof setTimeout>;
  }>();
  private conversationContainerStarts = new Map<string, Promise<import('./AgentContainerLauncher').AgentContainerLifecycle>>();

  hasActiveRunOnAnotherChannel(channelId: string, threadId: string): boolean {
    const currentKey = this.abortKey(channelId, threadId);
    return [...this.activeAborts.keys()].some(key => key !== currentKey && key.endsWith(`|${ threadId }`));
  }

  private async waitForOtherChannelRun(channelId: string, threadId: string): Promise<void> {
    const deadline = Date.now() + CONVERSATION_CONTAINER_SWITCH_WAIT_MS;
    while (this.hasActiveRunOnAnotherChannel(channelId, threadId)) {
      if (Date.now() >= deadline) {
        const { AgentLaunchError } = await import('./AgentContainerLauncher');
        throw new AgentLaunchError('This conversation is still busy with another agent\'s turn. Send your message again when it finishes.', true);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private abortKey(channelId: string, threadId: string): string {
    return `${ channelId }|${ threadId }`;
  }

  private humanSendKey(channelId: string, threadId: string, sendId: string): string {
    return `${ channelId }|${ threadId }|${ sendId }`;
  }

  private humanSendIds(send: HumanSendDispatch): string[] {
    const ids = [send.sendId, ...(Array.isArray(send.coalescedSendIds) ? send.coalescedSendIds : [])];
    return [...new Set(ids.filter(id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)))].slice(0, 101);
  }

  private emitHumanSendReceipt(channelId: string, send: HumanSendDispatch, threadId: string, status: 'accepted' | 'cancelled' | 'rejected'): void {
    for (const sendId of this.humanSendIds(send)) {
      this.emitMessage(channelId, 'human_send_receipt', {
        ...send,
        sendId,
        coalescedSendIds: undefined,
        threadId,
        thread_id: threadId,
        status,
      });
    }
  }

  /** Accept once the backend owns the send in a graph state, never on optimistic UI alone. */
  private acceptHumanSend(channelId: string, threadId: string, send: HumanSendDispatch): boolean {
    const key = this.humanSendKey(channelId, threadId, send.sendId);
    const prior = this.humanSendReceipts.get(key);
    if (prior) {
      this.emitHumanSendReceipt(channelId, { ...send, route: prior.route, path: prior.path }, threadId, 'accepted');
      return true;
    }
    const sendIds = this.humanSendIds(send);
    const sendKeys = sendIds.map(sendId => this.humanSendKey(channelId, threadId, sendId));
    if (sendKeys.some(sendKey => this.cancelledHumanSends.has(sendKey))) {
      this.emitHumanSendReceipt(channelId, send, threadId, 'cancelled');
      for (const sendKey of sendKeys) this.humanSendInFlight.delete(sendKey);
      return false;
    }
    for (const sendKey of sendKeys) {
      this.humanSendReceipts.set(sendKey, { threadId, route: send.route, path: send.path });
      this.humanSendInFlight.delete(sendKey);
    }
    if (this.humanSendReceipts.size > 2048) {
      const oldest = this.humanSendReceipts.keys().next().value as string | undefined;
      if (oldest) this.humanSendReceipts.delete(oldest);
    }
    for (const sendId of sendIds) this.humanSendWaitRecorder.accepted({ ...send, sendId, coalescedSendIds: undefined }, threadId);
    this.emitHumanSendReceipt(channelId, send, threadId, 'accepted');
    return true;
  }

  private rejectHumanSend(channelId: string, threadId: string, send: HumanSendDispatch): void {
    const key = this.humanSendKey(channelId, threadId, send.sendId);
    const accepted = this.humanSendReceipts.get(key);
    if (accepted) {
      this.emitHumanSendReceipt(channelId, { ...send, route: accepted.route, path: accepted.path }, threadId, 'accepted');
      return;
    }
    const sendKeys = this.humanSendIds(send).map(sendId => this.humanSendKey(channelId, threadId, sendId));
    for (const sendKey of sendKeys) this.humanSendInFlight.delete(sendKey);
    const status = sendKeys.some(sendKey => this.cancelledHumanSends.has(sendKey)) ? 'cancelled' : 'rejected';
    this.emitHumanSendReceipt(channelId, send, threadId, status);
  }

  private cancelledHumanSend(channelId: string, threadId: string, send: HumanSendDispatch): boolean {
    const sendKeys = this.humanSendIds(send).map(sendId => this.humanSendKey(channelId, threadId, sendId));
    if (!sendKeys.some(key => this.cancelledHumanSends.has(key))) return false;
    this.emitHumanSendReceipt(channelId, send, threadId, 'cancelled');
    for (const key of sendKeys) this.humanSendInFlight.delete(key);
    return true;
  }

  private armConversationIdle(key: string, lifecycle: import('./AgentContainerLauncher').AgentContainerLifecycle): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const current = this.conversationContainers.get(key);
      if (current?.lifecycle !== lifecycle) return;
      const threadId = key;
      if ([...this.activeAborts.keys()].some(activeKey => activeKey.endsWith(`|${ threadId }`))) {
        current.idleTimer = this.armConversationIdle(key, lifecycle);
        return;
      }
      this.conversationContainers.delete(key);
      lifecycle.close('conversation-idle-timeout', 'BackendGraphWebSocketService.armConversationIdle')
        .catch(error => console.warn('[BackendGraphWS] Failed to reap idle conversation container:', error));
    }, CONVERSATION_CONTAINER_IDLE_MS);
    timer.unref();
    return timer;
  }

  /** Returns true when the wake actually dispatched a turn, false when a live run is already in flight. */
  async wakeParkedAgent(channelId: string, threadId: string, message: string, agentId?: string, messageMeta: Record<string, unknown> = {}): Promise<boolean> {
    // Do not await parked-state lookup before checking a live owner: that gap
    // lets a busy turn finish and schedule its own continuation before this
    // wake decides to start another graph for the same input.
    const liveState = GraphRegistry.get(threadId);
    const liveWaiter = agentJobLifecycle.hasLiveWaiter(threadId);
    if (this.hasParentInputRun(channelId, threadId, liveState?.state)) {
      if (liveWaiter && !liveState) {
        console.warn(`[BackendGraphWS] Live waiter for thread ${ threadId } has no GraphRegistry state; waking without delivering the message.`);
        agentJobLifecycle.wake(threadId);
        return false;
      }
      return this.steerOrchestratorMessageIfBusy(channelId, threadId, message, messageMeta);
    }

    await waitForAutomaticAgentExecution(this.recoveryAbort.signal);
    const parked = await parkedAgentRehydrator.resolve(threadId);
    if (!parked) throw new Error(`Thread ${ threadId } is not a parked agent job.`);
    // The manager is blocked inside spawn_agent's own in-process wait for its
    // children (waitForWake registered for this exact thread in THIS
    // process). Its own loop owns that turn's lifecycle — inject the message
    // into its live state and release the waiter instead of dispatching a
    // disconnected new turn, which would leave this exact Promise (and its
    // eventual completeJob/deliverJobCompletion once the loop returns)
    // blocked forever.
    const delegated = GraphRegistry.get(threadId);
    if (agentJobLifecycle.hasLiveWaiter(threadId)) {
      // Should not happen — the waiter and this GraphRegistry entry share the
      // same spawn_agent call's lifetime — but release the waiter either way
      // so a contradiction here cannot leak the Promise.
      if (!delegated) {
        console.warn(`[BackendGraphWS] Live waiter for thread ${ threadId } has no GraphRegistry state; waking without delivering the message.`);
        agentJobLifecycle.wake(threadId);
        return false;
      }
      await this.injectActiveParentInput(channelId, threadId, 'orchestrator',
        this.orchestratorMessageFormatter.format(message, String(messageMeta.jobMessageKind ?? '')),
        { source: 'orchestrator_job_message', inputSource: 'system', ...messageMeta },
        [String(messageMeta.jobMessageId ?? ''), ...(Array.isArray(messageMeta.jobMessageIds) ? messageMeta.jobMessageIds.map(String) : [])]);
      agentJobLifecycle.wake(threadId);
      return true;
    }
    // The worker can persist its wait just before spawn_agent registers the
    // in-process waiter. Keep this wake on the same graph: inject now and
    // latch the wake for waitForWake() to consume once settlement begins.
    if (delegated && (delegated.state.metadata as any)?.delegatedRunActive) {
      await this.injectActiveParentInput(channelId, threadId, 'orchestrator',
        this.orchestratorMessageFormatter.format(message, String(messageMeta.jobMessageKind ?? '')),
        { source: 'orchestrator_job_message', inputSource: 'system', ...messageMeta },
        [String(messageMeta.jobMessageId ?? ''), ...(Array.isArray(messageMeta.jobMessageIds) ? messageMeta.jobMessageIds.map(String) : [])]);
      agentJobLifecycle.wake(threadId);
      return true;
    }
    // A turn already in flight for this thread through dispatchToAgent itself
    // must receive the durable wake on its own GraphRegistry state. Never
    // start a second graph for the same thread.
    if (this.hasActiveRun(channelId, threadId)) {
      return this.injectActiveParentInput(channelId, threadId, 'orchestrator',
        this.orchestratorMessageFormatter.format(message, String(messageMeta.jobMessageKind ?? '')),
        { source: 'orchestrator_job_message', inputSource: 'system', ...messageMeta },
        [String(messageMeta.jobMessageId ?? ''), ...(Array.isArray(messageMeta.jobMessageIds) ? messageMeta.jobMessageIds.map(String) : [])]);
    }
    const receipt = await this.dispatchToAgent(channelId, channelId === HEARTBEAT_CHANNEL_ID ? 'heartbeat' : 'sulla-desktop',
      this.orchestratorMessageFormatter.format(message, String(messageMeta.jobMessageKind ?? '')), threadId, undefined, agentId || parked.agentId, 'system', {
        source: 'orchestrator_job_message', ...messageMeta,
      });
    return receipt !== 'deferred';
  }

  /** Every completion claim owned by this turn, including steers injected into a live delegated run. */
  private claimedCompletionEntries(state: AgentGraphState | undefined, metadata: Record<string, any> | undefined): PendingCompletion[] {
    const entries = [
      ...(Array.isArray(metadata?.completionEntries) ? metadata.completionEntries : []),
      ...((state?.messages ?? []).flatMap((message: any) =>
        message?.metadata?.source === 'sub_agent_completion' && Array.isArray(message.metadata.completionEntries)
          ? message.metadata.completionEntries
          : [])),
    ] as PendingCompletion[];
    const unique = new Map<string, PendingCompletion>();
    for (const entry of entries) unique.set(CompletionKey.of(entry), entry);
    return [...unique.values()];
  }

  private hasParentInput(state: AgentGraphState, kind: ParentInputWaitKind, inputId: string): boolean {
    return state.messages.some((message: any) => Array.isArray(message?.metadata?.parentInputWait)
      && message.metadata.parentInputWait.some((wait: ParentInputWaitRecord) => wait.kind === kind && wait.inputId === inputId));
  }

  /** Drop active parent-input copies on abort; their durable source is what must retry. */
  private releaseUnconsumedParentInputSteers(state: AgentGraphState): void {
    const released = new Set((state.messages as any[]).filter(message =>
      message?.metadata?.steerPending === true && Array.isArray(message?.metadata?.parentInputWait)));
    if (!released.size) return;
    state.messages.splice(0, state.messages.length, ...state.messages.filter(message => !released.has(message as any)));
  }

  private deferParentInputs(
    kind: ParentInputWaitKind,
    threadId: string,
    inputIds: string[],
    state: AgentGraphState,
    queuedAtById: Map<string, number> = new Map(),
  ): ParentInputWaitRecord[] {
    const ids = [...new Set(inputIds)].filter(id => id && !this.hasParentInput(state, kind, id));
    if (!ids.length) return [];
    const deferredAtMs = Date.now();
    const runId = typeof (state.metadata as any).runId === 'string' ? (state.metadata as any).runId : undefined;
    return ids.map(inputId => this.parentInputWaitRecorder.deferred({
      kind,
      threadId,
      inputId,
      queuedAtMs: queuedAtById.get(inputId) ?? deferredAtMs,
      deferredAtMs,
      ...(runId ? { runId } : {}),
    }));
  }

  private hasParentInputRun(channelId: string, threadId: string, state = GraphRegistry.get(threadId)?.state): boolean {
    const metadata = state?.metadata as any;
    return this.hasActiveRun(channelId, threadId)
      || this.hasActiveRunOnAnotherChannel(channelId, threadId)
      || Boolean(metadata?.runtimeRunnerActive)
      || Boolean(metadata?.delegatedRunActive)
      || agentJobLifecycle.hasLiveWaiter(threadId);
  }

  /** Route durable manager messages into a live graph without acknowledging before a provider boundary. */
  steerOrchestratorMessageIfBusy(channelId: string, threadId: string, message: string, messageMeta: Record<string, unknown> = {}): boolean {
    const graph = GraphRegistry.get(threadId);
    if (!this.hasParentInputRun(channelId, threadId, graph?.state)) return false;
    const liveWaiter = agentJobLifecycle.hasLiveWaiter(threadId);
    if (liveWaiter && !graph) {
      agentJobLifecycle.wake(threadId);
      return false;
    }
    const injected = this.injectActiveParentInput(channelId, threadId, 'orchestrator',
      this.orchestratorMessageFormatter.format(message, String(messageMeta.jobMessageKind ?? '')),
      { source: 'orchestrator_job_message', inputSource: 'system', ...messageMeta },
      [String(messageMeta.jobMessageId ?? ''), ...(Array.isArray(messageMeta.jobMessageIds) ? messageMeta.jobMessageIds.map(String) : [])]);
    if (liveWaiter || Boolean((graph?.state.metadata as any)?.delegatedRunActive)) agentJobLifecycle.wake(threadId);
    return injected;
  }

  private parentInputAcknowledger(
    channelId: string,
    threadId: string,
    records: ParentInputWaitRecord[],
    metadata: Record<string, any>,
    completionConsumption?: CompletionConsumptionRecorder,
  ): () => Promise<void> {
    return async() => {
      const completionIds = new Set(records.filter(wait => wait.kind === 'completion').map(wait => wait.inputId));
      const completions = (Array.isArray(metadata.completionEntries) ? metadata.completionEntries as PendingCompletion[] : [])
        .filter(entry => completionIds.has(CompletionKey.of(entry)));
      for (const entry of completions) {
        if (CompletionKey.isTaskCompletion(entry)) await agentJobProvider.jobs.markTaskCompletionFirstDelivered(entry.jobId, entry.taskIndex, Date.now());
        await agentJobProvider.completionAcknowledgements.acknowledge(entry);
      }
      (completionConsumption ?? this.activeCompletionConsumptions.get(this.abortKey(channelId, threadId)))?.confirmConsumed(completions);

      const jobMessageIds = records.filter(wait => wait.kind === 'orchestrator').map(wait => wait.inputId);
      if (jobMessageIds.length) await AgentJobMessagingModel.markMessagesDelivered(jobMessageIds, threadId);

      const inboxMessageIds = records.filter(wait => wait.kind === 'agent_inbox').map(wait => wait.inputId);
      if (inboxMessageIds.length) await this.agentInbox.acknowledgeEntries({ channel: channelId, threadId }, inboxMessageIds);
    };
  }

  private injectActiveParentInput(
    channelId: string,
    threadId: string,
    kind: ParentInputWaitKind,
    content: string,
    metadata: Record<string, any>,
    inputIds: string[],
    completionEntries: PendingCompletion[] = [],
    queuedAtById: Map<string, number> = new Map(),
  ): boolean {
    const graph = GraphRegistry.get(threadId);
    const state = graph?.state as AgentGraphState | undefined;
    if (!state || !this.hasParentInputRun(channelId, threadId, state)) return false;
    const ids = [...new Set(inputIds.filter(Boolean))];
    const existing = ids.filter(id => this.hasParentInput(state, kind, id));
    const newIds = ids.filter(id => !existing.includes(id));
    if (ids.length && !newIds.length) return existing.length > 0;
    const records = this.deferParentInputs(kind, threadId, newIds, state, queuedAtById);
    if (newIds.length && !records.length) return existing.length > 0;
    const selectedCompletions = kind === 'completion'
      ? completionEntries.filter(entry => records.some(wait => wait.inputId === CompletionKey.of(entry)))
      : [];
    const nextMetadata = {
      ...metadata,
      ...(selectedCompletions.length ? { completionEntries: selectedCompletions } : {}),
      ...(records.length ? { parentInputWait: records } : {}),
    };
    if (kind === 'completion') this.activeCompletionConsumptions.get(this.abortKey(channelId, threadId))?.recordInjected(selectedCompletions);
    injectSteer(state as any, {
      id: nextMessageId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      metadata: nextMetadata,
    } as any, records.length ? {
      recorder: this.parentInputWaitRecorder,
      onConsumed: this.parentInputAcknowledger(channelId, threadId, records, nextMetadata, this.activeCompletionConsumptions.get(this.abortKey(channelId, threadId))),
    } : undefined);
    for (const record of records) this.parentInputWaitRecorder.injected(record);
    return true;
  }

  /** True while a turn is in flight for this thread (an idle chat is not running). */
  hasActiveRun(channelId: string, threadId: string): boolean {
    return this.activeAborts.has(this.abortKey(channelId, threadId));
  }

  /** Resolves whether this turn runs in the VM or a container. */
  resolveRunLocation(state: AgentGraphState, channelId: string): 'vm' | 'container' {
    return this.runLocationResolver.resolve(state, channelId);
  }

  /** Execute an explicitly owner-authorized API turn through the same guest
   * lifecycle used by UI chat dispatch, so CLI and Files actor mounts exist. */
  async executeOwnerApiGraph<T>(state: AgentGraphState, channelId: string, threadId: string, action: () => T, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<Awaited<T>> {
    return this.runInConversationContainer(state, channelId, threadId, action, onProgress, signal);
  }

  private async runInConversationContainer<T>(state: AgentGraphState, channelId: string, threadId: string, action: () => T, onProgress?: (message: string) => void, signal?: AbortSignal, assertOwner: () => void = () => {}): Promise<Awaited<T>> {
    const { modelRouter } = await import('../languagemodels/modelRouter');
    const routedAgentId = resolveAgentIdentity(state.metadata);
    const definition = routedAgentId ? await agentDefinitionService.findBySlug(routedAgentId).catch(() => null) : null;
    const { effectiveModelChoice } = await import('../languagemodels/threadModelChoice');
    const workerRoute = !(state.metadata as any).workerModelChatOverride && (state.metadata as any).workerModelRoute;
    const choice = workerRoute ? undefined : effectiveModelChoice({ provider: state.metadata.agent?.provider, model: state.metadata.agent?.model, effort: state.metadata.agent?.effort, metadata: state.metadata, agentChoice: definition?.model_choice });
    const routed = (workerRoute ? await workerModelRouting.resolveRoute(workerRoute, signal) : await modelRouter.resolve('agents', choice))[0];
    assertOwner();
    const provider = String(routed?.provider || state.metadata.agent?.provider || '').trim();
    return executeWithContainerLifecycleRecovery(
      () => acquireWhenReady(() => { assertOwner(); return this.conversationContainer(channelId, threadId, provider, state) }, message => onProgress?.(message), signal),
      lost => { assertOwner(); return this.recoverConversationContainer(channelId, threadId, provider, state, lost) },
      action,
    );
  }

  constructor(private readonly turnPreparer = new DelegatedTurnPreparer(), dependencies: { inboxRepository?: AgentInboxRepository; inboxReceiverResolver?: AgentInboxReceiverResolver; inboxRunGuard?: ReceiverRunGuard } = {}) {
    const repository = dependencies.inboxRepository ?? new PostgresAgentInboxRepository(new DesktopPostgresConnection(postgresClient));
    this.inboxRunGuard = dependencies.inboxRunGuard ?? new ReceiverRunGuard();
    this.inboxReceiverResolver = dependencies.inboxReceiverResolver ?? new DurableAgentInboxReceiverResolver(
      agentJobProvider.jobs,
      channel => GraphRegistry.findThreadsByChannel(channel).map(candidate => ({ ...candidate, executing: this.hasActiveRun(channel, candidate.threadId) || this.inboxRunGuard.isActive({ channel, threadId: candidate.threadId }) })),
    );
    this.agentInbox = new AgentInbox(repository, {
      isRunning: target => this.inboxRunGuard.isActive(target) || this.inboxThread(target) !== undefined,
      wake: async(target, batch, entries) => this.wakeInbox(target, batch, entries),
    }, this.inboxRunGuard);
    const orgSession = new DesktopOrgCloudSession();
    this.orgMessengerFleet = new OrgMessengerFleet(
      new OrgMembershipDirectory(),
      new DesktopOrgMessengerFactory(
        new PostgresOrgMessagingStateRepository(new DesktopPostgresConnection(postgresClient)),
        this.agentInbox,
        { target: async envelope => ({ channel: SULLA_DESKTOP_CHANNEL_ID, threadId: envelope.data.conversationId }) },
        new OrgContactRequestDecisionPrompter(),
        { halt: async target => { if (target.threadId) await new AgentTurnStopper(this.wsService).stop(target.channel, target.threadId); } },
      ),
      { userId: () => orgSession.userId(), activeOrgId: () => orgSession.orgId() },
    );
    registerCompletionIdleDispatcher((channelId, threadId) => this.handleCompletionWake(channelId, threadId));
    this.initialize();
  }

  private completionHandoff?: DelegatedCompletionHandoff;

  /** Lazy so bare test instances (Object.create) still get one. */
  private get delegatedCompletionHandoff(): DelegatedCompletionHandoff {
    return this.completionHandoff ??= new DelegatedCompletionHandoff(
      { take: takeAgentCompletions, format: formatCompletionBatch, currentEntries: (...args) => completionInboxStore.currentEntries(...args) },
      agentJobLifecycle,
      {
        firstDelivered: entry => agentJobProvider.jobs.markTaskCompletionFirstDelivered(entry.jobId, entry.taskIndex, Date.now()),
        acknowledge:    entry => agentJobProvider.completionAcknowledgements.acknowledge(entry),
      },
      (state, message, options) => { injectSteer(state as any, message, options) },
      nextMessageId,
      Date.now,
      this.parentInputWaitRecorder,
      (channel, threadId, entries) => this.activeCompletionConsumptions.get(this.abortKey(channel, threadId))?.confirmConsumed(entries),
    );
  }

  /** Sends through the target org's own outbox; `org` (id, slug or name) defaults to the active org. */
  sendOrgMessage(envelope: import('@sulla/domain').MessageEnvelope, org?: string): Promise<void> {
    return this.orgMessengerFleet.send(envelope, org);
  }

  /** Resolves an org the human belongs to (default: active org); refuses non-member orgs. */
  resolveMessagingOrg(org?: string): Promise<OrgMembership> {
    return this.orgMessengerFleet.resolveOrg(org);
  }

  /** The target org and the caller's id on that org's host (Cloud user id, or the Server subject). */
  orgMessagingParticipant(org?: string): Promise<{ membership: OrgMembership; userId: string }> {
    return this.orgMessengerFleet.participant(org);
  }

  /** The target org's people and agent addresses, read from the org's own host. */
  loadOrgDirectory(org?: string): Promise<{ membership: OrgMembership; directory: { people: readonly unknown[] } }> {
    return this.orgMessengerFleet.loadDirectory(org);
  }

  /** Pending contact requests for the signed-in member in the target org (read-only). */
  contactRequests(org?: string): Promise<readonly import('@sulla/domain').MessageEnvelope['data'][]> {
    return this.orgMessengerFleet.contactRequests(org);
  }

  memberOrganizations(): Promise<readonly OrgMembership[]> {
    return this.orgMessengerFleet.memberOrganizations();
  }

  loadOrgInboxMessages(org?: string): Promise<{ membership: OrgMembership; messages: readonly MessageEnvelope[] }> {
    return this.orgMessengerFleet.loadInboxMessages(org);
  }

  startOrgConversation(request: OrgConversationStartRequest, org?: string): Promise<{ membership: OrgMembership; conversationId: string }> {
    return this.orgMessengerFleet.startConversation(request, org);
  }

  /** LiveEvents wake hook for org messaging; polling every 60 s remains the fallback. */
  onOrgLiveEvent(topic: string, orgId?: string): void {
    this.orgMessengerFleet.onLiveEvent(topic, orgId);
  }

  private inboxThread(target: AgentInboxTarget): string | undefined {
    if (target.threadId) return this.hasActiveRun(target.channel, target.threadId) ? target.threadId : undefined;
    const prefix = `${ target.channel }|`;
    return [...this.activeAborts.keys()].find(key => key.startsWith(prefix))?.slice(prefix.length);
  }

  private readonly deliveringDecisionThreads = new Set<string>();

  private decisionThreadOwned(channel: string, threadId: string): boolean {
    const metadata = GraphRegistry.get(threadId)?.state.metadata as any;
    return this.hasActiveRun(channel, threadId) || !!metadata?.runtimeRunnerActive || !!metadata?.delegatedRunActive || agentJobLifecycle.hasLiveWaiter(threadId);
  }

  private async retryDecisionAnswers(): Promise<void> {
    clearTimeout(this.decisionAnswerRetry); this.decisionAnswerRetry = undefined;
    if (agentExecutionReadiness.draining) return;
    if (this.decisionAnswerRetrying) { this.decisionAnswerRetry = setTimeout(() => { this.retryDecisionAnswers() }, 15_000); this.decisionAnswerRetry.unref?.(); return }
    this.decisionAnswerRetrying = true;
    const generation = this.decisionAnswerGeneration;
    let pending = true;
    try {
      const { decisionService } = await import('./DecisionService');
      const targets = await decisionService.pendingAnswerTargets([...this.deliveringDecisionThreads]);
      if (generation !== this.decisionAnswerGeneration) return;
      pending = targets.length > 0;
      for (const target of targets) if (!this.inboxThread(target)) this.agentInbox.flush(target).catch(error => console.warn('[BackendGraphWS] Answer remains queued:', error?.name));
    } catch { /* Durable records remain queued while storage reconnects. */ } finally { this.decisionAnswerRetrying = false }
    if (generation !== this.decisionAnswerGeneration) return;
    if (pending && !agentExecutionReadiness.draining) {
      this.decisionAnswerRetry = setTimeout(() => { this.retryDecisionAnswers() }, 15_000);
      this.decisionAnswerRetry.unref?.();
    }
  }

  private async wakeInbox(target: AgentInboxTarget, batch: string, entries: AgentInboxEntry[]): Promise<AgentInboxDeliveryReceipt> {
    const human = entries.every(entry => entry.envelope.kind === 'human');
    const threadId = target.threadId || this.inboxThread(target);
    const targetState = target.threadId ? GraphRegistry.get(target.threadId)?.state : undefined;
    const activeThreadRun = !!target.threadId && (this.hasActiveRun(target.channel, target.threadId)
      || Boolean((targetState?.metadata as any)?.delegatedRunActive)
      || agentJobLifecycle.hasLiveWaiter(target.threadId));
    const steerEntries = entries.filter(entry => entry.envelope.kind !== 'human' && entry.envelope.kind !== 'decision');
    if (activeThreadRun && steerEntries.length) {
      const inboxMessageIds = steerEntries.map(entry => entry.envelope.ids.messageId);
      const queuedAtById = new Map(steerEntries.map(entry => [entry.envelope.ids.messageId, entry.queuedAtMs ?? Date.now()] as [string, number]));
      await this.injectActiveParentInput(target.channel, target.threadId!, 'agent_inbox', this.agentInbox.render(steerEntries), {
        source: 'agent_inbox',
        inputSource: 'system',
        inboxMessageIds,
        relayed: steerEntries.some(entry => entry.envelope.ids.relayed === true),
      }, inboxMessageIds, [], queuedAtById);
      // Deferred is intentionally not acknowledged: the provider-boundary
      // callback owns that transition, while Stop falls back to the durable row.
      return 'deferred';
    }
    if (this.inboxThread(target) || this.inboxRunGuard.isActive(target)
      || (human && target.threadId && this.decisionThreadOwned(target.channel, target.threadId))) return 'deferred';
    if (human && threadId) this.deliveringDecisionThreads.add(threadId);
    try {
      let receiverAgentId = target.agentId;
      if (human) {
        const recordedIdentity = entries[0]?.target?.agentId;
        // On the shared desktop channel the recorded receiver may be only the transport default
        // (conversation_history.agent_id); an exact agent saved on the thread is the real role.
        const recordedSharedDefault = target.channel === SULLA_DESKTOP_CHANNEL_ID && recordedIdentity === SULLA_DESKTOP_CHANNEL_ID;
        let savedIdentity = (!recordedIdentity || recordedSharedDefault) && threadId ? resolveAgentIdentity((GraphRegistry.get(threadId)?.state ?? await loadThreadState(threadId))?.metadata) : '';
        // After a restart or Redis expiry the graph is rebuilt with only the shared default identity;
        // the exact agent the user selected on the linked chat is then the saved role. A failed read
        // throws, so the answer stays undelivered for retry instead of running on the default agent.
        if (target.channel === SULLA_DESKTOP_CHANNEL_ID && threadId && (!recordedIdentity || recordedSharedDefault) && (!savedIdentity || savedIdentity === SULLA_DESKTOP_CHANNEL_ID)) {
          const selected = await ConversationThreadStore.findSelectedAgent(threadId);
          if (selected && selected !== SULLA_DESKTOP_CHANNEL_ID) savedIdentity = selected;
        }
        receiverAgentId = (recordedSharedDefault ? savedIdentity || recordedIdentity : recordedIdentity || savedIdentity) || target.agentId || (target.channel !== SULLA_DESKTOP_CHANNEL_ID && target.channel !== HEARTBEAT_CHANNEL_ID ? target.channel : undefined);
      }
      return await this.dispatchToAgent(
        target.channel,
        target.channel === HEARTBEAT_CHANNEL_ID ? 'heartbeat' : 'sulla-desktop',
        batch,
        threadId,
        undefined,
        receiverAgentId,
        human ? 'keyboard' : 'system',
        { source: 'agent_inbox', workerMappingNewHumanTurn: human, inboxMessageIds: entries.map(entry => entry.envelope.ids.messageId), relayed: entries.some(entry => entry.envelope.ids.relayed === true) },
        entries.filter(entry => entry.envelope.ids.messageId.startsWith('decision-answer:')).map(entry => ({ id: entry.envelope.ids.messageId, attempt: String((entry.envelope.ids as any).answerAttempt ?? ''), body: entry.envelope.body })),
      );
    } finally { if (human && threadId) this.deliveringDecisionThreads.delete(threadId); }
  }

  /**
   * One owner for a settled completion's delivery to the parent thread. A
   * thread with a live in-process waiter (spawn_agent's own waitForWake for
   * this exact thread) owns that turn's lifecycle itself: inject the batch
   * into its live state and release the waiter so its own loop resumes,
   * completes and delivers to ITS parent. Dispatching a brand-new turn here
   * instead would run disconnected from that still-blocked Promise, leaving
   * it (and the job it is waiting to complete) blocked forever.
   */
  private async handleCompletionWake(channelId: string, threadId: string): Promise<void> {
    await waitForAutomaticAgentExecution(this.recoveryAbort.signal);
    if (this.hasActiveRun(channelId, threadId)) {
      const claimed = takeAgentCompletions(channelId, threadId);
      if (!claimed.length) return;
      const regular = claimed.filter(entry => !CompletionKey.isStall(entry));
      const stalls = claimed.filter(entry => CompletionKey.isStall(entry));
      if (regular.length) {
        // Do not await advisory-stall validation before steering real helper
        // results: a later completion could otherwise overtake this batch.
        const queuedAtById = new Map(regular.map(entry => [CompletionKey.of(entry), entry.queuedAtMs ?? Date.now()] as [string, number]));
        const injected = this.injectActiveParentInput(channelId, threadId, 'completion', formatCompletionBatch(regular), {
          source: 'sub_agent_completion',
          inputSource: 'system',
          completionEntries: regular,
        }, regular.map(CompletionKey.of), regular, queuedAtById);
        if (!injected) for (const entry of regular) {
          if (this.hasActiveRun(channelId, threadId)) requeueAgentCompletionQuietly(channelId, threadId, entry);
          else requeueAgentCompletionAfterFailure(channelId, threadId, entry);
        }
      }
      if (stalls.length) {
        const currentStalls = await completionInboxStore.currentEntries(channelId, threadId, stalls);
        if (!currentStalls.length) return;
        const queuedAtById = new Map(currentStalls.map(entry => [CompletionKey.of(entry), entry.queuedAtMs ?? Date.now()] as [string, number]));
        const injected = this.injectActiveParentInput(channelId, threadId, 'completion', formatCompletionBatch(currentStalls), {
          source: 'sub_agent_completion',
          inputSource: 'system',
          completionEntries: currentStalls,
        }, currentStalls.map(CompletionKey.of), currentStalls, queuedAtById);
        if (!injected) for (const entry of currentStalls) {
          if (this.hasActiveRun(channelId, threadId)) requeueAgentCompletionQuietly(channelId, threadId, entry);
          else requeueAgentCompletionAfterFailure(channelId, threadId, entry);
        }
      }
      return;
    }
    const delegated = GraphRegistry.get(threadId);
    // A runner-owned delegated manager (parked or mid-turn) gets the batch
    // injected and its runner woken; never a second, disconnected turn.
    if (await this.delegatedCompletionHandoff.deliver(channelId, threadId, delegated?.state as any)) return;
    const entries = takeAgentCompletions(channelId, threadId);
    if (!entries.length) return;
    // Same trigger mapping as handleChannelMessage: only heartbeat has its own
    // trigger; mobile-relay and custom agent channels dispatch as sulla-desktop.
    const triggerType = channelId === HEARTBEAT_CHANNEL_ID ? 'heartbeat' : 'sulla-desktop';
    // Wake the agent that owns the thread. The trigger default is the typed
    // sulla-desktop agent, so a voice thread's worker results came back from
    // the heavy agent instead of as a short spoken reply.
    void parkedAgentRehydrator.isTerminalDelegatedThread(threadId).then(async(terminal) => {
      // A human stop is final. Child results remain readable and durably
      // undelivered, but must never resurrect the stopped parent thread.
      // Drop the in-memory claim so a later recovery enqueue is not discarded as a duplicate.
      if (terminal) {
        for (const entry of entries) releaseAgentCompletionClaim(entry);
        return;
      }
      const parked = await parkedAgentRehydrator.resolve(threadId);
      const threadAgentId = String((delegated?.state.metadata as any)?.agentId || parked?.agentId || '').trim() || undefined;
      return this.dispatchToAgent(channelId, triggerType, '', threadId, undefined, threadAgentId, 'system', {
        source: 'sub_agent_completion', completionEntries: entries, renderCompletionEntries: true,
      });
    }).catch(err => {
      // Requeue (enqueue would drop these claimed entries as duplicates) with
      // backoff, so a persistent failure is retried later, not hot-looped.
      for (const entry of entries) requeueAgentCompletionAfterFailure(channelId, threadId, entry);
      console.error('[BackendGraphWS] Failed to dispatch completion batch:', err);

    });
  }

  async drain(): Promise<void> {
    this.recoveryAbort.abort();
    for (const waits of this.readinessWaits.values()) for (const wait of waits) wait.abort();
    this.unsubscribes.forEach(unsubscribe => unsubscribe());
    this.unsubscribes = [];
    agentWaitProvider.scheduler.stop();
    for (const abort of this.activeAborts.values()) abort.abort();
    GraphRegistry.abortRuntimeRuns();
    await Promise.all([Promise.allSettled([...this.dispatchedRuns]), settleHiddenAgentRuns()]);
    this.dispose();
  }

  dispose(): void {
    this.orgMessagingAbort?.abort();
    this.orgMessagingAbort = undefined;
    this.decisionAnswerGeneration++;
    clearTimeout(this.decisionAnswerRetry); this.decisionAnswerRetry = undefined;
    this.unsubscribes.forEach(unsub => unsub());
    this.unsubscribes = [];
    for (const [, abort] of this.activeAborts) {
      abort.abort();
    }
    for (const key of this.activeAborts.keys()) releaseChatActivity(`graph:${ key }`);
    this.activeAborts.clear();
    this.suspendedRuns.clear();
    this.resumeContexts.clear();
    for (const [, record] of this.conversationContainers) {
      clearTimeout(record.idleTimer);
      record.lifecycle.close('service-dispose', 'BackendGraphWebSocketService.dispose')
        .catch(error => console.warn('[BackendGraphWS] Failed to close conversation container:', error));
    }
    this.conversationContainers.clear();
    this.subscribedChannels.clear();
  }

  /** Stamp only runs actually in flight when macOS suspends. */
  handleSuspend(): void {
    this.suspendedRuns = new Set(this.activeAborts.keys());
    console.log(`[BackendGraphWS] System suspending with ${ this.suspendedRuns.size } in-flight chat run(s)`);
  }

  /**
   * Wake recovery. Snapshot the threads whose runs crossed sleep BEFORE
   * reinitialize(): dispose() aborts every in-flight run (their LLM sockets
   * died while the Mac slept) and clears the resume bookkeeping, so reading
   * it afterwards would find nothing and the tabs would stay stopped.
   * Then re-subscribe and send each interrupted thread a continue.
   */
  handleResume(): void {
    const interrupted = [...this.suspendedRuns]
      .map(key => this.resumeContexts.get(key))
      .filter((context): context is NonNullable<typeof context> => !!context);
    this.suspendedRuns.clear();
    this.reinitialize();
    if (interrupted.length) console.log(`[BackendGraphWS] Continuing ${ interrupted.length } chat thread(s) interrupted by system sleep`);
    for (const context of interrupted) {
      // Give the aborted runs a moment to unwind their finally blocks first.
      setTimeout(() => {
        void this.dispatchToAgent(
          context.channelId, context.triggerType,
          'Continue from where you stopped after the computer resumed. Preserve and process any queued messages.',
          context.threadId, context.scopedWorkflowId, context.overrideAgentId, context.inputSource,
          { source: 'system_resume', inputSource: 'system' },
        ).catch(err => console.error('[BackendGraphWS] Failed to continue chat after resume:', err));
      }, RESUME_CONTINUE_DELAY_MS);
    }
  }

  private async conversationContainer(
    channelId: string,
    threadId: string,
    provider: string,
    state: AgentGraphState,
    recoveryCliSnapshot?: import('@pkg/shared/providerCliSelection').ProviderCliSnapshot,
  ): Promise<import('./AgentContainerLauncher').AgentContainerLifecycle> {
    const key = threadId;
    const agentId = String((state.metadata as any).agentId ?? state.metadata.wsChannel ?? '');
    for (;;) {
      const existing = this.conversationContainers.get(key);
      if (existing && !existing.lifecycle.closed && existing.agentId !== agentId && this.hasActiveRunOnAnotherChannel(channelId, threadId)) {
        // Do not kill or lend another agent's lifecycle to a parallel channel turn.
        // Wait outside the creation lock so the existing run can still reacquire its container.
        await this.waitForOtherChannelRun(channelId, threadId);
        continue;
      }
      const starting = this.conversationContainerStarts.get(key);
      if (starting) {
        // A cross-agent replacement may be waiting for another channel's active turn.
        // Let that turn keep using its own lifecycle while the new agent waits.
        if (existing && !existing.lifecycle.closed && existing.agentId === agentId &&
            [...this.activeAborts.keys()].some(activeKey => activeKey.endsWith(`|${ threadId }`))) {
          return existing.lifecycle;
        }
        await starting.catch(() => undefined);
        continue;
      }
      const start = this.createOrReuseConversationContainer(channelId, threadId, provider, state, key, recoveryCliSnapshot);
      this.conversationContainerStarts.set(key, start);
      try {
        return await start;
      } catch (error) {
        if (error instanceof ConversationContainerBusyError) continue;
        throw error;
      } finally {
        if (this.conversationContainerStarts.get(key) === start) this.conversationContainerStarts.delete(key);
      }
    }
  }

  private async createOrReuseConversationContainer(
    channelId: string, threadId: string, provider: string, state: AgentGraphState, key: string,
    recoveryCliSnapshot?: import('@pkg/shared/providerCliSelection').ProviderCliSnapshot,
  ): Promise<import('./AgentContainerLauncher').AgentContainerLifecycle> {
    const existing = this.conversationContainers.get(key);
    const metadata = state.metadata as any;
    const route = !metadata.workerModelChatOverride && metadata.workerModelRoute;
    let providerCliSnapshot = recoveryCliSnapshot;
    const delegatedJobId = metadata.delegatedJobId ?? metadata.workerModelTask?.jobId;
    if (delegatedJobId && !providerCliSnapshot) {
      const { getJob } = await import('../tools/agents/jobRegistry');
      const taskIndex = Number.isInteger(metadata.delegatedTaskIndex) ? metadata.delegatedTaskIndex : Number(metadata.workerModelTask?.taskIndex ?? 0);
      providerCliSnapshot = (await getJob(String(delegatedJobId)))?.tasks[taskIndex]?.providerCliSnapshot;
    } else if (!providerCliSnapshot) {
      // Ordinary chats capture the approved selection once per root container.
      // A vanished container passes its captured snapshot through recovery; an
      // existing lifecycle keeps its own snapshot even when settings change.
      providerCliSnapshot = recoveryCliSnapshot ?? existing?.providerCliSnapshot;
      if (!providerCliSnapshot && !existing && !recoveryCliSnapshot) {
        const { captureProviderCliSnapshot } = await import('../../backend/providerCliUpdates');
        providerCliSnapshot = await captureProviderCliSnapshot();
      }
    }
    let workerMappingKey = JSON.stringify([route ? [route.slug, route.revision, route.connections] : null, providerCliSnapshot ?? null]);
    const model = state.metadata.agent?.model;
    // The container's capability token, Files actor and runtime binding all
    // carry the agent it was built for (AgentContainerLauncher), so it is
    // never handed to a different agent, not even mid-turn.
    const agentId = String((state.metadata as any).agentId ?? state.metadata.wsChannel ?? '');
    // A lifecycle that aborted or closed (container died, secrets were wiped, capability renewal
    // failed) is dead for good. Reusing it failed every later message in the thread; rebuild it.
    // The conversation itself survives: its workspace and provider homes live on the data disk.
    // While a turn is in flight the container is in use, and a provider fallback (Claude to Codex)
    // or model switch inside that turn must reuse it: recreating it removed the container under the
    // running turn ("No such container"). Both providers' homes are mounted in every container.
    const inUse = [...this.activeAborts.keys()].some(activeKey => activeKey.endsWith(`|${ threadId }`));
    // Compare what the container's provider bridge actually pins: slot aliases
    // ('primary', …) pin nothing, while 'fast' pins the resolved light model.
    const pinned = (value: string | undefined) => cliPinnedModelId(provider, value);
    if (existing && existing.workerMappingKey === workerMappingKey && !existing.lifecycle.closed && existing.agentId === agentId && ((existing.provider === provider && pinned(existing.model) === pinned(model)) || inUse)) {
      clearTimeout(existing.idleTimer);
      return existing.lifecycle;
    }
    if (existing) {
      if (existing.agentId !== agentId && this.hasActiveRunOnAnotherChannel(channelId, threadId)) {
        throw new ConversationContainerBusyError();
      }
      clearTimeout(existing.idleTimer);
      await existing.lifecycle.close(existing.agentId === agentId ? 'provider-or-model-switch' : 'agent-switch', 'BackendGraphWebSocketService.conversationContainer')
        .catch(error => console.warn('[BackendGraphWS] Failed to close dead conversation container:', error));
      this.conversationContainers.delete(key);
    }
    // Closing an idle or switched ordinary root is a new container launch, so
    // it adopts the current approved CLI selection. Recovery is the exception:
    // it must retain the vanished root's snapshot.
    if (!delegatedJobId && !recoveryCliSnapshot && existing) {
      const { captureProviderCliSnapshot } = await import('../../backend/providerCliUpdates');
      providerCliSnapshot = await captureProviderCliSnapshot();
      workerMappingKey = JSON.stringify([route ? [route.slug, route.revision, route.connections] : null, providerCliSnapshot]);
    }
    const { createAgentContainerLifecycle } = await import('./AgentContainerLauncher');
    const lifecycle = await createAgentContainerLifecycle({
      jobId: `chat-${ threadId }`, taskIndex: 0, provider,
      model, state, providerCliSnapshot,
      persistenceKey: conversationPersistenceKey(channelId, threadId, state),
    });
    const idleTimer = this.armConversationIdle(key, lifecycle);
    this.conversationContainers.set(key, { provider, model, agentId, lifecycle, idleTimer, workerMappingKey, providerCliSnapshot });
    return lifecycle;
  }

  private async recoverConversationContainer(
    channelId: string,
    threadId: string,
    provider: string,
    state: AgentGraphState,
    lost: import('./AgentContainerLauncher').AgentContainerLifecycle,
  ): Promise<import('./AgentContainerLauncher').AgentContainerLifecycle> {
    const key = threadId;
    const current = this.conversationContainers.get(key);
    const recoveryCliSnapshot = current?.lifecycle === lost ? current.providerCliSnapshot : undefined;
    if (current?.lifecycle === lost) {
      clearTimeout(current.idleTimer);
      this.conversationContainers.delete(key);
    }
    await lost.close('container-disappeared', 'BackendGraphWebSocketService.recoverConversationContainer')
      .catch(error => console.warn('[BackendGraphWS] Failed to close vanished conversation container:', error));
    console.warn(`[BackendGraphWS] Rebuilding vanished conversation container for ${ key }; retrying the same provider`);
    return await this.conversationContainer(channelId, threadId, provider, state, recoveryCliSnapshot);
  }

  /**
   * Tear down and re-establish all WebSocket channel subscriptions.
   * Called after system resume to ensure the backend graph executor
   * re-registers its message handlers on the freshly reconnected sockets.
   */
  reinitialize(): void {
    console.log('[BackendGraphWS] reinitialize — re-subscribing to all channels after system resume');
    this.dispose();
    this.initialize(false);
    this.retryDecisionAnswers();
  }

  private initialize(recover = true): void {
    const subscriptionGeneration = this.decisionAnswerGeneration;
    import('./DecisionService').then(({ decisionService }) => {
      if (subscriptionGeneration !== this.decisionAnswerGeneration) return;
      this.unsubscribes.push(decisionService.subscribe(record => {
        if (record.answerDelivery === 'queued') this.retryDecisionAnswers();
      }));
    });
    this.wsService.connect(SULLA_DESKTOP_CHANNEL_ID);
    const sullaUnsub = this.wsService.onMessage(SULLA_DESKTOP_CHANNEL_ID, (msg) => {
      this.handleChannelMessageSafely(SULLA_DESKTOP_CHANNEL_ID, 'sulla-desktop', msg);
    });
    if (sullaUnsub) this.unsubscribes.push(sullaUnsub);

    this.wsService.connect(HEARTBEAT_CHANNEL_ID);
    const heartbeatUnsub = this.wsService.onMessage(HEARTBEAT_CHANNEL_ID, (msg) => {
      this.handleChannelMessageSafely(HEARTBEAT_CHANNEL_ID, 'heartbeat', msg);
    });
    if (heartbeatUnsub) this.unsubscribes.push(heartbeatUnsub);

    // Mobile relay channel — messages forwarded from a paired mobile device
    // via DesktopRelayClient. Agent processing is identical to the desktop
    // UI channel (same trigger type, same AgentNode pipeline) so the XML
    // wrappers, tool execution, memory recall, etc. all apply uniformly.
    this.wsService.connect(MOBILE_RELAY_CHANNEL_ID);
    const mobileRelayUnsub = this.wsService.onMessage(MOBILE_RELAY_CHANNEL_ID, (msg) => {
      this.handleChannelMessageSafely(MOBILE_RELAY_CHANNEL_ID, 'sulla-desktop', msg);
    });
    if (mobileRelayUnsub) this.unsubscribes.push(mobileRelayUnsub);

    // Initialize calendar event channel
    this.wsService.connect(CALENDAR_CHANNEL_ID);
    const calendarUnsub = this.wsService.onMessage(CALENDAR_CHANNEL_ID, (msg) => {
      this.handleCalendarMessage(msg);
    });
    if (calendarUnsub) this.unsubscribes.push(calendarUnsub);

    // Track built-in channels
    this.subscribedChannels.add(SULLA_DESKTOP_CHANNEL_ID);
    this.subscribedChannels.add(HEARTBEAT_CHANNEL_ID);
    this.subscribedChannels.add(MOBILE_RELAY_CHANNEL_ID);
    this.subscribedChannels.add(CALENDAR_CHANNEL_ID);

    // Register agents in the active agents registry
    this.registerAgent(SULLA_DESKTOP_CHANNEL_ID, 'Sulla', 'Frontend chat agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register sulla-desktop agent:', err));
    this.registerAgent(HEARTBEAT_CHANNEL_ID, 'Heartbeat', 'Autonomous heartbeat agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register heartbeat agent:', err));
    this.registerAgent(MOBILE_RELAY_CHANNEL_ID, 'Sulla (Mobile)', 'Chat routed from paired mobile device').catch(err =>
      console.warn('[BackendGraphWS] Failed to register mobile-relay agent:', err));
    this.deregisterAgent('workbench').catch(err =>
      console.warn('[BackendGraphWS] Failed to clear retired agent registration:', err));

    if (recover && !this.recoveryStarted) {
      this.recoveryStarted = true;
      this.recoverWhenReady().catch(error => {
        if (error?.name !== 'AbortError') console.warn('[BackendGraphWS] Agent recovery failed:', error);
      });
    } else if (!recover) {
      this.subscribeWhenReady().catch(error => {
        if (error?.name !== 'AbortError') console.warn('[BackendGraphWS] Channel resubscription failed:', error);
      });
    }
  }

  private async subscribeWhenReady(): Promise<void> {
    await agentExecutionReadiness.wait(this.recoveryAbort.signal);
    await this.subscribeToAgentChannels();
  }

  private async recoverWhenReady(): Promise<void> {
    for (;;) {
      await waitForAutomaticAgentExecution(this.recoveryAbort.signal);
      try {
        await this.recoverRuntimeWork();
        return;
      } catch (error: any) {
        if (error?.name === 'AbortError' || this.recoveryAbort.signal.aborted) return;
        console.warn('[BackendGraphWS] Agent recovery waiting for services:', error);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  private async recoverRuntimeWork(): Promise<void> {
    const { awaitAgentContainerRuntimeRehydration, probeAgentContainerRuntime } = await import('./AgentContainerRuntimeRegistry');
    await awaitAgentContainerRuntimeRehydration();
    await this.subscribeToAgentChannels();
    await agentWaitProvider.scheduler.start();
    // Provider import and heartbeat storage can wait on vault/DB initialization; neither may gate job recovery.
    void import('../app/Providers/ChatHeartbeatServiceProvider')
      .then(({ chatHeartbeatProvider }) => chatHeartbeatProvider.rehydrateJobHeartbeats())
      .catch(error => console.warn('[BackendGraphWS] Job heartbeat recovery failed:', error));
    await recoverPendingAgentCompletions();
    await this.agentInbox.replayPending();
    this.retryDecisionAnswers();
    const eligible = async(job: import('../tools/agents/jobRegistry').AgentJob): Promise<boolean> => {
      for (const task of job.tasks) {
        if (task.status !== 'running' || !task.threadId || task.returnedAt) continue;
        if (this.recoveryAbort.signal.aborted || this.hasActiveRun(job.parentChannel ?? 'sulla-desktop', task.threadId) ||
          (GraphRegistry.get(task.threadId)?.state.metadata as any)?.runtimeRunnerActive ||
          probeAgentContainerRuntime(undefined, task.threadId) !== false || await this.hasPendingDecision(task.threadId)) return false;
      }
      return true;
    };
    // Only startup's interrupted working set is eligible. Normal work created
    // later must never be restarted by this reconciliation loop.
    const pending = new Set((await agentJobProvider.jobs.jobsForList(1, false))
      .filter(job => job.createdAt <= this.recoveryCutoff && job.status === 'running' && job.visibility !== 'tab')
      .map(job => job.jobId));
    const recovery = new InterruptedAgentRecoveryService({
      claimInterruptedJobs: max => agentJobProvider.states.claimInterruptedJobs(max, eligible),
      recoveryCandidates:   async() => {
        const candidates = (await agentJobProvider.jobs.jobsForList(1, false))
          .filter(job => pending.has(job.jobId) && job.status === 'running');
        const active = new Set(candidates.map(job => job.jobId));
        for (const id of pending) if (!active.has(id)) pending.delete(id);
        return candidates;
      },
      claimInterruptedJob: async(id, max) => {
        const claimed = await agentJobProvider.states.claimInterruptedJob(id, max, eligible);
        if (claimed.resumable.length || claimed.exhausted.length) pending.delete(id);
        return claimed;
      },
    }, (job, taskIndex) => {
      // Dispatch owns/records the running turn. Do not wait for a possibly
      // hours-long worker before admitting its siblings or the next job.
      this.resumeInterruptedTask(job, taskIndex);
      return Promise.resolve();
    }, (job, reason) => {
      if (job.parentChannel && job.parentThreadId) enqueueAgentCompletion(job.parentChannel, job.parentThreadId, { jobId: job.jobId, taskIndex: -1, results: [], failureReason: reason });
    });
    await returnedTaskSettlement.settleStranded();
    if ((process as any).type === 'browser') {
      this.orgMessagingAbort?.abort();
      this.orgMessagingAbort = new AbortController();
      this.orgMessengerFleet.run(this.orgMessagingAbort.signal).catch(error => console.warn('[BackendGraphWS] Org messaging stopped unexpectedly:', error));
    }
    while (pending.size && !this.recoveryAbort.signal.aborted) {
      await waitForAutomaticAgentExecution(this.recoveryAbort.signal);
      await recovery.recover();
      if (pending.size) await this.waitForRecoveryRecheck();
    }
  }

  private resumeInterruptedTask(job: import('../tools/agents/jobRegistry').AgentJob, taskIndex: number): void {
    const run = (async() => {
      await waitForAutomaticAgentExecution(this.recoveryAbort.signal);
      const task = job.tasks[taskIndex];
      const channel = job.parentChannel || 'sulla-desktop';
      await this.dispatchToAgent(channel, channel === HEARTBEAT_CHANNEL_ID ? 'heartbeat' : 'sulla-desktop',
        `[Runtime restart recovery]\nThe previous runtime stopped while this delegated task was running. Continue from the durable thread state, preserve the original contract, and call return_result exactly once when finished.`,
        task.threadId, undefined, task.agentId, 'system', { source: 'runtime_restart_recovery', delegatedJobId: job.jobId });
    })();
    this.dispatchedRuns.add(run);
    run.catch(error => {
      if (error?.name !== 'AbortError') console.error('[BackendGraphWS] Interrupted worker dispatch failed:', error);
    }).finally(() => this.dispatchedRuns.delete(run));
  }

  private waitForRecoveryRecheck(): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.recoveryAbort.signal;
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(Object.assign(new Error('Recovery stopped'), { name: 'AbortError' })) };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 30_000);
      timer.unref?.();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private async hasPendingDecision(threadId: string): Promise<boolean> {
    const { PendingDecisionRepository } = await import('../repositories/PendingDecisionRepository');
    return new PendingDecisionRepository(postgresClient).hasPendingForConversation(threadId);
  }

  /**
   * Dynamically subscribe to a custom agent channel so it can receive messages.
   * Messages on custom agent channels are treated as 'sulla-desktop' trigger type.
   */
  subscribeToChannel(channelId: string): void {
    if (this.subscribedChannels.has(channelId)) return;
    this.wsService.connect(channelId);
    const unsub = this.wsService.onMessage(channelId, (msg) => {
      this.handleChannelMessageSafely(channelId, 'sulla-desktop', msg);
    });
    if (unsub) this.unsubscribes.push(unsub);
    this.subscribedChannels.add(channelId);
  }

  /** Subscribe to every enabled DB-backed agent channel. */
  private async subscribeToAgentChannels(): Promise<void> {
    try {
      const { agentDefinitionService } = await import('./AgentDefinitionService');
      for (const agent of await agentDefinitionService.list()) {
        if (agent.enabled && agent.status !== 'archive') this.subscribeToChannel(agent.slug);
      }
    } catch (err) {
      console.error('[BackendGraphWS] Error scanning agent channels:', err);
    }
  }

  // ------------------------------------------------------------------
  // Unified channel message handling — dispatches to default agent via GraphRegistry
  // ------------------------------------------------------------------

  /**
   * A turn can fail before dispatchToAgent's own error handling starts (for
   * example a database read while resolving the route). Without this the
   * rejection went nowhere: the window never heard the turn ended and showed
   * "working" forever. Report it on the thread and end the run state.
   */
  private async handleChannelMessageSafely(
    channelId: string,
    triggerType: 'sulla-desktop' | 'heartbeat',
    msg: WebSocketMessage,
  ): Promise<void> {
    try {
      await this.handleChannelMessage(channelId, triggerType, msg);
    } catch (err: any) {
      if (err?.name === 'AbortError' || agentExecutionReadiness.draining) return;
      console.error(`[BackendGraphWS] ${ msg.type } on ${ channelId } failed before the agent started:`, err);
      if (msg.type !== 'user_message' && msg.type !== 'inject_message') return;
      const data = typeof msg.data === 'string' ? {} : (msg.data as any);
      const threadId = typeof data?.threadId === 'string' ? data.threadId : undefined;
      const rawSend = data?.humanSend as Partial<HumanSendDispatch> | undefined;
      const send = typeof rawSend?.sendId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(rawSend.sendId) && threadId
        ? {
          sendId: rawSend.sendId,
          ...(Array.isArray(rawSend.coalescedSendIds) ? { coalescedSendIds: rawSend.coalescedSendIds.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)).slice(0, 100) } : {}),
          route: rawSend.route === 'steer' || rawSend.route === 'new_turn' ? rawSend.route : 'idle',
          path: rawSend.path === 'queued' || rawSend.path === 'injected' ? rawSend.path : 'sent_fresh',
          enqueuedAtMs: typeof rawSend.enqueuedAtMs === 'number' && Number.isFinite(rawSend.enqueuedAtMs) ? rawSend.enqueuedAtMs : Date.now(),
        } satisfies HumanSendDispatch
        : undefined;
      if (send && threadId) this.rejectHumanSend(channelId, threadId, send);
      this.emitMessage(channelId, 'assistant_message', {
        content:   `Agent error: ${ err?.message || String(err) }`,
        role:      'assistant',
        kind:      'error',
        thread_id: threadId,
      });
      this.emitMessage(channelId, 'transfer_data', {
        role: 'system', content: 'graph_execution_complete', stopReason: 'error', waitingForUser: false, thread_id: threadId,
      });
    }
  }

  private async handleChannelMessage(
    channelId: string,
    _triggerType: 'sulla-desktop' | 'heartbeat',
    msg: WebSocketMessage,
  ): Promise<void> {
    const candidateThread = (msg.data as { threadId?: unknown } | null)?.threadId;
    if (channelId !== MOBILE_RELAY_CHANNEL_ID && typeof candidateThread === 'string' && candidateThread.startsWith('remote_')
        && ['user_message', 'inject_message', 'stop_run'].includes(msg.type)) return;
    if ((msg.type === 'user_message' || msg.type === 'inject_message') && msg.data && typeof msg.data === 'object') {
      const data = msg.data as any;
      msg = { ...msg, data: { ...data, metadata: DecisionAnswerDelivery.publicMetadata(data.metadata) } };
    }
    if (msg.type === 'stop_run') {
      const data = typeof msg.data === 'string' ? {} : (msg.data as any);
      const stopThreadId = typeof data?.threadId === 'string' ? data.threadId.trim() : '';
      const stopTabId = typeof data?.tabId === 'string' ? data.tabId.trim() : '';
      console.log(`[BackendGraphWS:stop_run] channelId=${ channelId }, tabId=${ stopTabId || '(none)' }, threadId=${ stopThreadId || '(none)' }`);

      // A WebSocket channel is shared by every desktop chat tab. It is not a
      // run-ownership boundary, so missing/stale client identity must fail
      // closed. A stale thread id simply finds no active abort handle.
      if (!stopThreadId) {
        console.warn(`[BackendGraphWS:stop_run] ignored unscoped stop for channelId=${ channelId }, tabId=${ stopTabId || '(none)' }`);
        return;
      }
      if (channelId === MOBILE_RELAY_CHANNEL_ID) {
        const run = this.relayRuns.get(stopThreadId);
        if (!run || run.id !== data?.relayRunId) return;
        run.controller.abort();
      }
      for (const wait of this.readinessWaits?.get(this.abortKey(channelId, stopThreadId)) ?? []) wait.abort();
      this.activeAborts.get(this.abortKey(channelId, stopThreadId))?.abort();
      setCompletionInboxStopped(channelId, stopThreadId, true);
      return;
    }

    if (msg.type === 'decision_answer_queued') {
      const { decisionService } = await import('./DecisionService');
      const record = await decisionService.find((msg.data as any)?.decisionId);
      if (record?.channel === channelId && record.kind === 'question' && record.answerDelivery === 'queued') {
        this.retryDecisionAnswers();
      }
      return;
    }

    if (msg.type === 'agent_inbox_message') {
      const data = typeof msg.data === 'string' ? {} : (msg.data as any);
      const envelope = data?.envelope;
      if (!envelope?.ids?.messageId || !envelope?.body || envelope?.kind !== 'peer') return;
      let target: AgentInboxTarget;
      try {
        target = await this.inboxReceiverResolver.resolve(channelId, envelope.targetId, envelope.replyToThreadId ?? data?.targetThreadId);
      } catch (error) {
        if (error instanceof AmbiguousAgentInboxTargetError || error instanceof NoAgentInboxTargetError) {
          const senderChannel = String(envelope.senderChannel || '');
          const senderThreadId = String(envelope.senderThreadId || '');
          if (senderChannel && senderThreadId) {
            this.emitMessage(senderChannel, 'subconscious_message', {
              content: `a2a delivery ${ envelope.ids.messageId } failed`, role: 'assistant', kind: 'a2a_delivery_status', thread_id: senderThreadId,
              a2aDeliveryStatus: { messageId: envelope.ids.messageId, status: 'failed', reason: error.message },
            });
            await this.agentInbox.receive({
              envelope: { from: channelId, kind: 'blocker', body: `Peer message was not delivered: ${error.message} Re-address the message using <channel:${channelId}#threadId-or-jobId>... if needed.`, senderChannel: channelId, ids: { messageId: nextMessageId() } },
              target: { channel: senderChannel, threadId: senderThreadId, agentId: senderChannel },
            });
          } else console.warn('[BackendGraphWS] peer routing error could not wake sender: sender thread/channel missing', { senderChannel, senderThreadId });
          return;
        }
        throw error;
      }
      let receipt: Awaited<ReturnType<AgentInbox['receive']>> | AgentInboxDeliveryReceipt;
      try {
        receipt = await this.agentInbox.receive({ envelope, target });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const senderChannel = String(envelope.senderChannel || '');
        const senderThreadId = String(envelope.senderThreadId || '');
        if (senderChannel && senderThreadId) {
          this.emitMessage(senderChannel, 'subconscious_message', {
            content: `a2a delivery ${envelope.ids.messageId} failed`, role: 'assistant', kind: 'a2a_delivery_status', thread_id: senderThreadId,
            a2aDeliveryStatus: { messageId: envelope.ids.messageId, status: 'failed', reason },
          });
          await this.agentInbox.receive({
            envelope: { from: channelId, kind: 'blocker', body: `Peer message was not delivered: ${reason} Re-address the message using <channel:${channelId}#threadId-or-jobId>... if needed.`, senderChannel: channelId, ids: { messageId: nextMessageId() } },
            target: { channel: senderChannel, threadId: senderThreadId, agentId: senderChannel },
          });
        }
        return;
      }
      this.emitMessage(channelId, 'subconscious_message', {
        content: envelope.body, role: 'assistant', kind: 'channel_message',
        // The sender's structured blocker/contract intent is authoritative.
        agentReporting: envelope.kind === 'blocker' || envelope.kind === 'contract' ? 'brief' : undefined,
        thread_id: target.threadId,
        senderId: envelope.from,
        senderChannel: envelope.senderChannel,
        senderLabel: envelope.senderLabel,
        senderJobId: envelope.senderJobId,
        fromThreadId: envelope.senderThreadId,
        targetId: envelope.targetId,
      });
      if (envelope.senderChannel && envelope.senderThreadId) {
        const delivery = mapInboxReceiptToA2aStatus(receipt);
        this.emitMessage(envelope.senderChannel, 'subconscious_message', {
          content: `a2a delivery ${ envelope.ids.messageId } ${ delivery.status }${ delivery.reason ? ` (${delivery.reason})` : '' }`, role: 'assistant', kind: 'a2a_delivery_status', thread_id: envelope.senderThreadId,
          a2aDeliveryStatus: { messageId: envelope.ids.messageId, ...delivery },
        });
        if (delivery.status === 'failed') await this.agentInbox.receive({
          envelope: { from: channelId, kind: 'blocker', body: `Peer message was not delivered: ${delivery.reason || 'delivery failed'}. Re-address the message using <channel:${channelId}#threadId-or-jobId>... if needed.`, senderChannel: channelId, ids: { messageId: nextMessageId() } },
          target: { channel: envelope.senderChannel, threadId: envelope.senderThreadId, agentId: envelope.senderChannel },
        });
      }
      return;
    }

    if (msg.type === 'new_conversation') {
      const data = typeof msg.data === 'string' ? {} : (msg.data as any);
      const threadId = data?.threadId as string | undefined;
      if (threadId) {
        GraphRegistry.delete(threadId);
        const key = threadId;
        const container = this.conversationContainers.get(key);
        if (container) {
          clearTimeout(container.idleTimer);
          this.conversationContainers.delete(key);
          await container.lifecycle.close('new-conversation', 'BackendGraphWebSocketService.handleChannelMessage')
            .catch(error => console.warn('[BackendGraphWS] Failed to close conversation container:', error));
        }
      }
      return;
    }

    // Human send receipt/cancellation protocol is scoped to one channel/thread.
    // Dedupe state is keyed by opaque ids only; message content never enters the ledger or perf log.
    const humanData = typeof msg.data === 'string' ? {} : (msg.data as any);
    const humanThreadId = typeof humanData?.threadId === 'string' ? humanData.threadId : undefined;
    const rawHumanSend = humanData?.humanSend as Partial<HumanSendDispatch> | undefined;
    const sendId = typeof rawHumanSend?.sendId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(rawHumanSend.sendId)
      ? rawHumanSend.sendId
      : undefined;
    const enqueuedAtMs = typeof rawHumanSend?.enqueuedAtMs === 'number' && Number.isFinite(rawHumanSend.enqueuedAtMs)
      ? rawHumanSend.enqueuedAtMs
      : Date.now();
    const send: HumanSendDispatch | undefined = sendId ? {
      sendId,
      ...(Array.isArray(rawHumanSend?.coalescedSendIds) ? { coalescedSendIds: rawHumanSend.coalescedSendIds.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)).slice(0, 100) } : {}),
      route: rawHumanSend?.route === 'steer' || rawHumanSend?.route === 'new_turn' ? rawHumanSend.route : 'idle',
      path: rawHumanSend?.path === 'queued' || rawHumanSend?.path === 'injected' ? rawHumanSend.path : 'sent_fresh',
      enqueuedAtMs,
    } : undefined;

    const suppliedContent = typeof humanData?.content === 'string' ? humanData.content.trim() : '';
    const suppliedAttachments = Array.isArray(humanData?.metadata?.attachments) && humanData.metadata.attachments.length > 0;
    const suppliedFiles = Array.isArray(humanData?.metadata?.fileReferences) && humanData.metadata.fileReferences.length > 0;
    if (send && humanThreadId && !suppliedContent && !suppliedAttachments && !suppliedFiles) {
      this.rejectHumanSend(channelId, humanThreadId, send);
      return;
    }

    if (msg.type === 'cancel_human_send') {
      const threadId = humanThreadId;
      const sendIds = Array.isArray(humanData?.sendIds) ? humanData.sendIds : [];
      if (!threadId) return;
      for (const rawId of sendIds) {
        if (typeof rawId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(rawId)) continue;
        const key = this.humanSendKey(channelId, threadId, rawId);
        const accepted = this.humanSendReceipts.get(key);
        if (accepted) {
          this.emitHumanSendReceipt(channelId, { sendId: rawId, route: accepted.route, path: accepted.path, enqueuedAtMs }, threadId, 'accepted');
          continue;
        }
        this.cancelledHumanSends.add(key);
        this.humanSendInFlight.delete(key);
        if (this.cancelledHumanSends.size > 2048) {
          const oldest = this.cancelledHumanSends.values().next().value as string | undefined;
          if (oldest) this.cancelledHumanSends.delete(oldest);
        }
        this.emitHumanSendReceipt(channelId, {
          sendId: rawId,
          route: rawHumanSend?.route === 'new_turn' ? 'new_turn' : 'steer',
          path: rawHumanSend?.path === 'queued' ? 'queued' : 'injected',
          enqueuedAtMs,
        }, threadId, 'cancelled');
      }
      return;
    }

    const sendKey = sendId && humanThreadId ? this.humanSendKey(channelId, humanThreadId, sendId) : undefined;
    if (send && sendKey) {
      const existingReceipt = this.humanSendReceipts.get(sendKey);
      if (existingReceipt) {
        this.emitHumanSendReceipt(channelId, { ...send, route: existingReceipt.route, path: existingReceipt.path }, humanThreadId!, 'accepted');
        return;
      }
      if (this.cancelledHumanSends.has(sendKey)) {
        this.emitHumanSendReceipt(channelId, send, humanThreadId!, 'cancelled');
        return;
      }
      if (this.humanSendInFlight.has(sendKey)) return;
      this.humanSendInFlight.add(sendKey);
    }

    // ── Inject message into running graph state (no execution trigger) ──
    const incomingMetadata = humanData?.metadata as Record<string, unknown> | undefined;
    const routeChanging = !!(incomingMetadata?.agentId || incomingMetadata?.workflowId || incomingMetadata?.useCaseIntent
      || incomingMetadata?.inputSource === 'voice' || (Array.isArray(incomingMetadata?.attachments) && incomingMetadata.attachments.length > 0));
    const shouldSteerUserMessage = msg.type === 'user_message' && !!send && !routeChanging;
    const routeThreadId = humanThreadId ?? (typeof humanData?.threadId === 'string' ? humanData.threadId : undefined);
    const routeRun = routeThreadId ? this.activeAborts.get(this.abortKey(channelId, routeThreadId)) : undefined;
    const routeGraph = routeThreadId ? GraphRegistry.get(routeThreadId) : undefined;
    const routeGraphBusy = !!routeGraph && (
      agentJobLifecycle.hasLiveWaiter(routeThreadId!)
      || (routeGraph.state.metadata as any)?.delegatedRunActive === true
    );
    if (send && routeChanging && routeThreadId && ((routeRun && !routeRun.signal.aborted) || routeGraphBusy)) {
      // Do not replace a live turn when renderer state lagged behind the
      // backend. Tell the renderer to keep the original send visibly queued;
      // it can retry with the same id after the active turn ends.
      this.rejectHumanSend(channelId, routeThreadId, { ...send, route: 'new_turn', path: 'queued' });
      return;
    }
    if (msg.type === 'inject_message' || shouldSteerUserMessage) {
      const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data as any);
      const content = (data?.content ?? '').trim();
      const threadId = data?.threadId as string | undefined;
      const hasAttachments = (Array.isArray(data?.metadata?.attachments) && data.metadata.attachments.length > 0)
        || (Array.isArray(data?.metadata?.fileReferences) && data.metadata.fileReferences.length > 0);
      if ((!content && !hasAttachments) || !threadId) return;
      if (channelId === MOBILE_RELAY_CHANNEL_ID) {
        const run = this.relayRuns.get(threadId);
        if (!run || run.id !== data?.relayRunId || run.controller.signal.aborted) return;
      }

      // Only a thread with a run in flight can absorb a steer. A registered
      // but idle graph would just hold the message with nobody to read it.
      const runKey = this.abortKey(channelId, threadId);
      const activeRun = this.activeAborts.get(runKey);
      const existing = activeRun && !activeRun.signal.aborted ? GraphRegistry.get(threadId) : undefined;
      if (existing) {
        if (existing.state.metadata.supportSessionId !== data?.metadata?.supportSessionId && data?.metadata?.supportSessionId) {
          await this.applySupportSessionCapability(existing.state, data?.metadata);
        }
        if (send && humanThreadId && this.cancelledHumanSend(channelId, humanThreadId, send)) return;
        // The run can finish while support capabilities are loaded. Only append
        // to the state still owned by the same live run; otherwise fall through
        // to a fresh dispatch so no final-iteration steer is orphaned.
        const sameLiveRun = this.activeAborts.get(runKey) === activeRun
          && !activeRun.signal.aborted
          && GraphRegistry.get(threadId)?.state === existing.state;
        if (!sameLiveRun) {
          console.info(`[BackendGraphWS] Run changed while accepting a human send for thread ${ threadId }; handing it to a fresh turn`);
        } else {
        // Run in flight — steer it without starting a new execution
        const attachments = data?.metadata?.attachments as any[] | undefined;
        const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
        const files = Array.isArray(data?.metadata?.fileReferences) ? data.metadata.fileReferences : [];
        const fileContext = files.length ? `\n\n<attached_files>\n${ files.map((file:any) => `- ${ file.name ?? file.path } · file ${ file.fileId } · version ${ file.versionId } · path ${ file.path }`).join('\n') }\nWhen returning one of these files, include a sulla-file:// link with fileId, version, path, and name query parameters so Desktop renders a durable file card.\n</attached_files>` : '';
        const contextualContent = `${ content }${ fileContext }`;
        const messageContent: any = hasAttachments
          ? [{ type: 'text', text: contextualContent }, ...attachments.filter((a: any) => a?.type === 'image' && a?.source?.type === 'base64')]
          : contextualContent;

        injectSteer(existing.state, {
          id:        send ? `user_${ send.sendId }` : nextMessageId(),
          role:      'user',
          content:   messageContent,
          timestamp: Date.now(),
          metadata:  {
            ...data?.metadata,
            ...(send ? { humanSendId: send.sendId, humanSendIds: this.humanSendIds(send), humanSendEnqueuedAtMs: send.enqueuedAtMs } : {}),
            source: data?.metadata?.source || 'inject',
            inputSource: data?.metadata?.inputSource || 'keyboard',
          },
        } as any);
        if (send) this.acceptHumanSend(channelId, threadId, { ...send, route: 'steer', path: 'injected' });
        console.log(`[BackendGraphWS] Steered running thread ${ threadId }`);
        return;
        }
      }

      if (channelId === MOBILE_RELAY_CHANNEL_ID) return;

      // Graph not found — fall through to full dispatch (triggers execution)
      console.log(`[BackendGraphWS] inject_message: no running state for thread ${ threadId }, falling back to full dispatch`);
    }

    if (msg.type !== 'user_message' && msg.type !== 'inject_message') return;

    const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data as any);
    const content = (data?.content ?? '').trim();
    const hasAttachments = (Array.isArray(data?.metadata?.attachments) && data.metadata.attachments.length > 0)
      || (Array.isArray(data?.metadata?.fileReferences) && data.metadata.fileReferences.length > 0);
    if (!content && !hasAttachments) return;

    // A hidden sub-agent opened in a tab is still driven by its spawn_agent
    // runner. A message typed into that tab steers the live run; starting a
    // second execution on the same state would race the runner.
    const delegated = typeof data?.threadId === 'string' ? GraphRegistry.get(data.threadId) : undefined;
    // A sub-agent parked mid in-process wait for its own children owns that
    // turn's lifecycle the same way: inject and release its waiter instead of
    // falling through to a disconnected new dispatchToAgent turn below.
    const parkedWaiter = typeof data?.threadId === 'string' && agentJobLifecycle.hasLiveWaiter(data.threadId);
    if ((content || hasAttachments) && delegated && (parkedWaiter || (delegated.state.metadata as any)?.delegatedRunActive)) {
      const delegatedState = delegated.state;
      const hasLiveWaiter = parkedWaiter;
      if (delegatedState.metadata.supportSessionId !== data?.metadata?.supportSessionId && data?.metadata?.supportSessionId) {
        await this.applySupportSessionCapability(delegatedState, data?.metadata);
      }
      if (send && humanThreadId && this.cancelledHumanSend(channelId, humanThreadId, send)) return;
      const stillDelegated = GraphRegistry.get(data.threadId as string)?.state === delegatedState
        && (hasLiveWaiter || (delegatedState.metadata as any)?.delegatedRunActive);
      if (stillDelegated) {
        injectSteer(delegatedState, {
          id:        send ? `user_${ send.sendId }` : nextMessageId(),
          role:      'user',
          content,
          timestamp: Date.now(),
          metadata:  {
            ...data?.metadata,
            ...(send ? { humanSendId: send.sendId, humanSendIds: this.humanSendIds(send), humanSendEnqueuedAtMs: send.enqueuedAtMs } : {}),
            source: data?.metadata?.source || 'inject',
            inputSource: data?.metadata?.inputSource || 'keyboard',
          },
        } as any);
        if (send) this.acceptHumanSend(channelId, data.threadId as string, { ...send, route: 'steer', path: 'injected' });
        if (parkedWaiter) agentJobLifecycle.wake(data.threadId as string);
        console.log(`[BackendGraphWS] Steered delegated run ${ data.threadId }`);
        return;
      }
    }

    // ThreadId is owned by the frontend chat interface — reuse it to maintain conversation
    const threadIdFromMsg = data?.threadId as string | undefined;

    // Scheduler ack
    const metadata = data?.metadata;
    if (metadata?.origin === 'scheduler' && typeof metadata?.eventId === 'number') {
      this.wsService.send(channelId, {
        type:      'scheduler_ack',
        data:      { eventId: metadata.eventId },
        timestamp: Date.now(),
      });
    }

    // Extract optional overrides from message metadata
    const scopedWorkflowId = metadata?.workflowId as string | undefined;
    const overrideAgentId = metadata?.agentId as string | undefined;
    const inputSource = metadata?.inputSource as string | undefined;

    if (channelId === MOBILE_RELAY_CHANNEL_ID) {
      if (msg.type !== 'user_message' || !threadIdFromMsg || typeof data?.relayRunId !== 'string'
          || this.relayRuns.has(threadIdFromMsg)) return;
      const run = { id: data.relayRunId as string, controller: new AbortController() };
      this.relayRuns.set(threadIdFromMsg, run);
      let status: string = 'failed';
      try {
        status = await this.dispatchToAgent(channelId, _triggerType, content, threadIdFromMsg, scopedWorkflowId,
          overrideAgentId, inputSource, metadata, undefined, run.controller);
      } finally {
        this.relayRuns.delete(threadIdFromMsg);
        this.emitMessage(channelId, 'relay_dispatch_complete', {
          thread_id: threadIdFromMsg, relayRunId: run.id,
          outcome: run.controller.signal.aborted ? 'stopped' : status,
        });
      }
      return;
    }

    const route: HumanSendRoute = threadIdFromMsg && this.activeAborts.has(this.abortKey(channelId, threadIdFromMsg)) ? 'new_turn' : 'idle';
    const acceptedSend: HumanSendDispatch | undefined = send ? {
      ...send,
      route,
      path: 'sent_fresh',
    } : undefined;
    const dispatchMetadata = {
      ...metadata,
      workerMappingNewHumanTurn: isWorkerMappingHumanTurn(msg.type, channelId, metadata),
      ...(acceptedSend ? { humanSend: acceptedSend } : {}),
    };
    const dispatch = this.dispatchToAgent(channelId, _triggerType, content, threadIdFromMsg, scopedWorkflowId, overrideAgentId, inputSource, dispatchMetadata);
    if (acceptedSend && threadIdFromMsg) {
      void dispatch.then(status => {
        if (status !== 'accepted') this.rejectHumanSend(channelId, threadIdFromMsg, acceptedSend);
      }).catch(() => this.rejectHumanSend(channelId, threadIdFromMsg, acceptedSend));
      return;
    }
    await dispatch;
  }

  private async applySupportSessionCapability(state: AgentGraphState, metadata?: Record<string, unknown>): Promise<void> {
    const policy = new SupportSessionPolicy();
    const supportSessionId = policy.sessionForTurn(state.metadata.supportSessionId, metadata?.supportSessionId);
    if (supportSessionId) {
      const supportTabTools = policy.remoteToolNames(SUPPORT_TOOL_NAMES);
      state.metadata.supportSessionId = supportSessionId;
      state.metadata.allowedToolNames = supportTabTools;
      state.metadata.supportContext = policy.remoteContext();
      (state as any).llmTools = await Promise.all(supportTabTools.map(name => toolRegistry.convertToolToLLM(name)));
    }
  }

  private dispatchToAgent(channelId: string, triggerType: string, message: string, threadIdFromMsg?: string, scopedWorkflowId?: string, overrideAgentId?: string, inputSource?: string, metadata?: Record<string, any>, decisionInputs?: DecisionAnswerDeliveryInput[], relayController?: AbortController): Promise<AgentInboxDeliveryReceipt> {
    const threadId = threadIdFromMsg || nextThreadId();
    const key = this.abortKey(channelId, threadId);
    const controller = relayController ?? new AbortController();
    const waiters = this.readinessWaits.get(key) ?? new Set<AbortController>();
    waiters.add(controller);
    this.readinessWaits.set(key, waiters);
    const run = (async(): Promise<AgentInboxDeliveryReceipt> => {
      try {
        const automatic = inputSource === 'system' || channelId === HEARTBEAT_CHANNEL_ID || metadata?.source === 'system_resume';
        await AgentReadinessStatus.wait(automatic ? waitForAutomaticAgentExecution : agentExecutionReadiness.wait.bind(agentExecutionReadiness), controller.signal, (content, status) => {
          this.emitMessage(channelId, 'assistant_message', {
            content, ...status, role: 'assistant', kind: 'progress', thread_id: threadId,
          });
          return Promise.resolve();
        });
        if (controller.signal.aborted || agentExecutionReadiness.draining) return 'deferred';
        // The guard ends here. Normal dispatch still replaces/steers active turns as before.
        return await this.executeReadyTurn(channelId, triggerType, message, threadIdFromMsg ?? threadId, scopedWorkflowId, overrideAgentId, inputSource, metadata, decisionInputs, relayController?.signal);
      } catch (error: any) {
        if (error?.name === 'AbortError') return 'deferred';
        throw error;
      } finally {
        waiters.delete(controller);
        if (!waiters.size) this.readinessWaits.delete(key);
      }
    })();
    this.dispatchedRuns.add(run);
    run.finally(() => this.dispatchedRuns.delete(run)).catch(() => undefined);
    if (!threadIdFromMsg) this.emitMessage(channelId, 'thread_created', { threadId });
    return run;
  }

  private async executeReadyTurn(channelId: string, triggerType: string, message: string, threadIdFromMsg?: string, scopedWorkflowId?: string, overrideAgentId?: string, inputSource?: string, metadata?: Record<string, any>, decisionInputs?: DecisionAnswerDeliveryInput[], relaySignal?: AbortSignal): Promise<AgentInboxDeliveryReceipt> {
    const answerInputs = decisionInputs ?? [];
    const decisionTurn = answerInputs.length > 0;
    if (decisionTurn && threadIdFromMsg && this.decisionThreadOwned(channelId, threadIdFromMsg)) return 'deferred';
    const automatedMessage = metadata?.source === 'orchestrator_job_message' ||
      (metadata?.source === 'agent_inbox' && inputSource === 'system');
    if (automatedMessage && threadIdFromMsg && await parkedAgentRehydrator.isTerminalDelegatedThread(threadIdFromMsg)) {
      console.info(`[BackendGraphWS] Message undeliverable to inactive job thread ${ threadIdFromMsg }`);
      return 'failed';
    }
    const wasActiveForWorkerMapping = !!threadIdFromMsg && this.hasActiveRun(channelId, threadIdFromMsg);
    const completionConsumption = new CompletionConsumptionRecorder();
    const { getModelProviderService } = await import('./ModelProviderService');
    const modelProvider = getModelProviderService();
    if (!modelProvider.isInitialized() || !modelProvider.getPrimaryProvider().trim()) {
      if (channelId === HEARTBEAT_CHANNEL_ID) {
        console.info('[BackendGraphWS] Skipped heartbeat: no AI provider is connected');
        return 'failed';
      }
      this.emitMessage(channelId, 'assistant_message', {
        content: 'No AI model is connected yet. Connect Claude, ChatGPT, Grok or an API key to start chatting.',
        role: 'assistant', kind: 'notice', thread_id: threadIdFromMsg,
      });
      firstRunTrace('chat', 'chat blocked before launch', { reason: 'no-ai-provider', channelId });
      return 'failed';
    }
    // Use the frontend's threadId if provided (maintains conversation).
    // Otherwise create a new one and notify the frontend via thread_created.
    const isNewThread = !threadIdFromMsg;
    const threadId = threadIdFromMsg || nextThreadId();
    if (!decisionTurn && metadata?.source !== 'sub_agent_completion') {
      const pendingCompletions = takeAgentCompletions(channelId, threadId);
      if (pendingCompletions.length) {
        metadata = {
          ...metadata,
          completionEntries: pendingCompletions,
          renderCompletionEntries: true,
        };
      }
    }

    const explicitAgentId = typeof overrideAgentId === 'string' ? overrideAgentId.trim() : '';
    const defaultAgentId = await getAgentIdForTrigger(triggerType) || channelId;
    let agentId = explicitAgentId || defaultAgentId;
    let newRoute: RoutableAgent | null = null;
    const threadModelSelection = new ThreadModelOverridePolicy().parse(metadata as Record<string, unknown> | undefined);

    // Default is resolved from Preferences on every turn. It is not a snapshot of the legacy
    // primary slot or of whatever Preferences happened to contain when the thread was created.
    if (!explicitAgentId && threadModelSelection.mode === 'default' && channelId === SULLA_DESKTOP_CHANNEL_ID && triggerType === 'sulla-desktop') {
      const routedAgent = await resolveDefaultRouteAgent();
      agentId = routedAgent.graphAgentId;
      newRoute = routedAgent;
    }

    // Explicit persona picks always win. A new chat opens on the selected agent or the
    // New chats default. A thread that already carries a stored route keeps it.
    else if (!explicitAgentId && channelId === SULLA_DESKTOP_CHANNEL_ID && triggerType === 'sulla-desktop') {
      const liveState = GraphRegistry.get(threadId)?.state;
      const priorState = liveState ?? await loadThreadState(threadId);
      const rememberedAgentId = String((priorState?.metadata as any)?.routedAgentId || '').trim();
      if (rememberedAgentId) agentId = rememberedAgentId;
    }

    let state: AgentGraphState | undefined;
    let turnConsumedInput = false;
    let turnTiming: TurnTiming | undefined;
    let turnTimingLifecycle: TurnTimingDispatchLifecycle | undefined;
    let turnOutcome: TurnTimingOutcome = 'ok';
    const abortKey = this.abortKey(channelId, threadId);
    let runAbort: AbortService | undefined;
    // Set only for a dormant parked job (no live in-process waiter) this turn
    // is waking. Re-parked in the finally block if the turn ends without the
    // job completing, so job/task status stays truthful for the turn's whole
    // duration rather than lying 'parked' while it is actually executing.
    let wakeTurnToRepark: { jobId: string; taskIndex: number } | undefined;

    const isCurrentRun = () => (!decisionTurn || !!runAbort) && this.activeAborts.get(abortKey) === runAbort;
    const assertDecisionOwner = () => {
      if (relaySignal?.aborted || (decisionTurn && (!isCurrentRun() || runAbort?.signal.aborted))) {
        const interrupted = new Error('Answer delivery interrupted'); interrupted.name = 'AbortError'; throw interrupted;
      }
    };

    try {
      const result = await GraphRegistry.getOrCreateAgentGraph(agentId, threadId) as { graph: any; state: AgentGraphState };
      const graph = result.graph;
      state = result.state;
      const parkedIdentity = await parkedAgentRehydrator.resolve(threadId);
      if (decisionTurn) {
        if (this.decisionThreadOwned(channelId, threadId)) return 'deferred';
        runAbort = new AbortService();
        this.activeAborts.set(abortKey, runAbort);
      }

      if (parkedIdentity) parkedAgentRehydrator.apply(state, parkedIdentity);

      if (newRoute) {
        applyThreadAgentRoute(state, newRoute);
        // Persist before execution so a renderer refresh or process interruption
        // cannot lose the sticky route chosen for this thread.
        await saveThreadState(state);
        assertDecisionOwner();
      }

      // A support tab supplies an opaque session id every turn. Resolve the
      // fixed tool set here rather than trusting renderer-provided names. If an
      // active session ends, the tab omits the id and the old capability is
      // synchronously removed before this turn can execute.
      await this.applySupportSessionCapability(state, metadata);
      assertDecisionOwner();

      // A saved/cached thread carries a historical copy of its agent config.
      // Run-location is deployment policy, so resolve it from the canonical row
      // on every dispatch before applying an explicit per-turn override.
      const currentDefinition = await agentDefinitionService.findBySlug(agentId);
      assertDecisionOwner();
      if (currentDefinition) {
        state.metadata.agent = {
          ...(state.metadata.agent ?? {}),
          runLocation: currentDefinition.run_location,
        };
      }

      // Model choices from the chat picker are scoped to this thread state;
      // they never mutate ModelProviderService or global settings.
      state.metadata.agent = new ThreadModelOverridePolicy().apply(state.metadata.agent as any, threadModelSelection);
      if (metadata?.workerMappingNewHumanTurn && threadModelSelection.mode !== 'unchanged') (state.metadata as any).workerModelChatOverride = threadModelSelection.mode === 'explicit';

      if (metadata?.runLocation === 'vm' || metadata?.runLocation === 'container') {
        state.metadata.agent = { ...(state.metadata.agent ?? {}), runLocation: metadata.runLocation };
      }

      // Notify frontend of the threadId so it can maintain the conversation
      if (isNewThread) {
        this.wsService.send(channelId, {
          type:      'thread_created',
          data:      { threadId },
          timestamp: Date.now(),
        });
      }

      let deferredStalls: PendingCompletion[] = [];
      let regularCompletions: PendingCompletion[] | undefined;
      if (!decisionTurn && Array.isArray(metadata?.completionEntries)) {
        const claimed: PendingCompletion[] = metadata.completionEntries;
        const entries = claimed.some(entry => entry.noticeKind === 'stall')
          ? await completionInboxStore.currentEntries(channelId, threadId, claimed) : claimed;
        metadata = { ...metadata, completionEntries: entries };
        if (!entries.length && metadata.source === 'sub_agent_completion' && !message && !metadata.attachments?.length && !metadata.fileReferences?.length) return 'accepted';
        deferredStalls = entries.filter(entry => CompletionKey.isStall(entry));
        regularCompletions = entries.filter(entry => !CompletionKey.isStall(entry));
        if (metadata.renderCompletionEntries) message = [message, formatCompletionBatch(regularCompletions)].filter(Boolean).join('\n\n');
        delete metadata.renderCompletionEntries;
      }

      // Completion and orchestrator wakes are accumulated instead of
      // superseding the active parent. Human/new-turn messages still replace
      // the prior turn. An orchestrator wake (source 'orchestrator_job_message',
      // from wakeParkedAgent) has nothing to re-enqueue here — its message was
      // already written to agent_job_messages by the caller before this
      // dispatch, and the finally block below redelivers anything still
      // pending once the active run ends.
      if ((metadata?.source === 'sub_agent_completion' || metadata?.source === 'orchestrator_job_message' || metadata?.source === 'agent_inbox') && this.activeAborts.has(abortKey) && (!decisionTurn || !isCurrentRun())) {
        const kind: ParentInputWaitKind = metadata.source === 'sub_agent_completion' ? 'completion'
          : metadata.source === 'orchestrator_job_message' ? 'orchestrator' : 'agent_inbox';
        const completionEntries = kind === 'completion' ? metadata.completionEntries ?? [] : [];
        const ids = kind === 'completion' ? completionEntries.map((entry: PendingCompletion) => CompletionKey.of(entry))
          : kind === 'orchestrator' ? [metadata.jobMessageId, ...(Array.isArray(metadata.jobMessageIds) ? metadata.jobMessageIds : [])].filter((id: unknown): id is string => typeof id === 'string')
            : (Array.isArray(metadata.inboxMessageIds) ? metadata.inboxMessageIds : []).filter((id: unknown): id is string => typeof id === 'string');
        const injected = await this.injectActiveParentInput(channelId, threadId, kind, String(message ?? ''), metadata, ids, completionEntries);
        if (!injected && kind === 'completion') {
          // Claimed by the caller's take: requeue clears that claim (enqueue would drop them).
          for (const entry of completionEntries) requeueAgentCompletionQuietly(channelId, threadId, entry);
        }
        return 'deferred';
      }
      // Keep completion claims owned while the graph runs. Active steers are
      // acknowledged by their provider-boundary callback; ordinary completion
      // inputs are committed only after the graph actually consumes them.
      for (const entry of decisionTurn ? [] : this.claimedCompletionEntries(state, metadata)) {
        completionConsumption.recordInjected([entry]);
      }
      if (metadata?.source !== 'sub_agent_completion') setCompletionInboxStopped(channelId, threadId, false);

      // Only a dormant parked TASK — no live in-process waiter held this
      // abortKey, or this dispatch would have returned just above — is
      // flipped running for the turn's duration. Re-parked in the finally
      // block unless the turn completes the job via return_result. Checked
      // on the task, not the job's rollup status: a sibling task can keep
      // the job itself 'running' while this one task is individually parked.
      if (parkedIdentity && parkedIdentity.task.status === 'parked') {
        await agentJobLifecycle.beginWakeTurn(parkedIdentity.job.jobId, parkedIdentity.taskIndex);
        wakeTurnToRepark = { jobId: parkedIdentity.job.jobId, taskIndex: parkedIdentity.taskIndex };
        assertDecisionOwner();
      }

      // Abort any prior run still in flight FOR THIS SAME THREAD before
      // starting a new one. Per-thread (not per-channel) so multiple chat
      // tabs sharing the same WebSocket channel can run in parallel.
      // Rapid double-sends from the same tab still get coalesced because
      // they share a thread id.
      if (decisionTurn && (!isCurrentRun() || runAbort?.signal.aborted)) return 'deferred';
      const prior = this.activeAborts.get(abortKey);
      if (prior && prior !== runAbort) {
        try {
          prior.abort();
        } catch {
          // already aborted
        }
        this.activeAborts.delete(abortKey);
      }

      // Create abort service for this run.
      // Set state first so stop_run can't race between activeAborts and state.
      const abort = runAbort ?? new AbortService();
      runAbort = abort;
      state.metadata.options.abort = abort;
      delete state.metadata.reportingDecisionFollowUp;
      this.activeAborts.set(abortKey, abort);
      this.activeCompletionConsumptions.set(abortKey, completionConsumption);
      const initialSteerRevision = state.metadata.reportingSteerRevision;
      this.resumeContexts.set(abortKey, {
        channelId, triggerType, threadId, scopedWorkflowId, overrideAgentId, inputSource,
      });
      acquireChatActivity(`graph:${ abortKey }`);
      // A turn starting is activity: a delegated tab that sat idle waiting on
      // its human must not read as a dead run the moment it wakes.
      RunActivity.touch(state.metadata);

      // Route responses back to the originating channel
      state.metadata.wsChannel = channelId;
      // Only turns initiated by the Desktop renderer's visible chat may emit
      // inline file cards. This is a trusted server-side signal; mobile relay,
      // relayed turns, chat-completions API calls, and sub-agents never qualify.
      (state.metadata as any).desktopChatVisible = channelId === SULLA_DESKTOP_CHANNEL_ID
        && triggerType === 'sulla-desktop'
        && metadata?.relayed !== true
        && (state.metadata as any).isSubAgent !== true
        && (state.metadata as any).userVisibleBrowser !== false;
      // Relayed organization turns are explicitly marked so BaseTool can
      // require approval for writes while still running as this Desktop's user.
      (state.metadata as any).relayed = metadata?.relayed === true;

      // Scope workflow tools to a specific workflow (e.g. when chatting from workflow editor)
      if (scopedWorkflowId) {
        (state.metadata as any).scopedWorkflowId = scopedWorkflowId;
      }

      // Track input modality so downstream nodes can adapt (e.g. voice → TTS).
      // Reset each dispatch so keyboard messages don't inherit a prior voice flag.
      (state.metadata as any).inputSource = inputSource || 'keyboard';
      // Content-free trace id of a spoken turn; BaseNode/SpeakExtractor stamp
      // their [VoiceTrace] spans with it. Reset per dispatch like inputSource.
      (state.metadata as any).voiceTurnId = cleanVoiceTurnId(metadata?.voiceTurnId);

      // Inter-agent wake: propagate replyToThread so ChannelTagExtractor on this
      // agent can include toThreadId when routing responses back to the caller.
      if (decisionTurn) {
        const { decisionService } = await import('./DecisionService');
        const started = await decisionService.startAnswers(answerInputs, threadId);
        if (started.length !== answerInputs.length || !isCurrentRun() || runAbort?.signal.aborted) {
          await decisionService.finishAnswers(answerInputs, threadId, false);
          return 'deferred';
        }
      }

      if (metadata?.replyToThread) {
        (state.metadata as any).replyToThread = String(metadata.replyToThread);
      }

      // Append user message — include image attachments as content blocks if present
      const attachments = metadata?.attachments as any[] | undefined;
      const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
      const files = Array.isArray(metadata?.fileReferences) ? metadata.fileReferences : [];
      const fileContext = files.length ? `\n\n<attached_files>\n${ files.map((file:any) => `- ${ file.name ?? file.path } · file ${ file.fileId } · version ${ file.versionId } · path ${ file.path }`).join('\n') }\nWhen returning one of these files, include a sulla-file:// link with fileId, version, path, and name query parameters so Desktop renders a durable file card.\n</attached_files>` : '';
      const contextualMessage = `${ message }${ fileContext }`;
      const messageContent: any = hasAttachments
        ? [
          { type: 'text', text: contextualMessage },
          ...attachments.filter((a: any) => a?.type === 'image' && a?.source?.type === 'base64'),
        ]
        : contextualMessage;

      const humanSend = metadata?.humanSend as HumanSendDispatch | undefined;
      if (humanSend && this.cancelledHumanSend(channelId, threadId, humanSend)) return 'deferred';

      DeferredStallInput.beginDispatch(state);
      if (deferredStalls.length) state.messages.push({
        id: nextMessageId(), role: 'user', content: '', timestamp: Date.now(),
        metadata: DeferredStallInput.metadata(channelId, threadId, deferredStalls),
      });
      if (!deferredStalls.length || contextualMessage || hasAttachments) {
        const inputMessage = {
          id:        humanSend ? `user_${ humanSend.sendId }` : nextMessageId(),
          role:      'user',
          content:   messageContent,
          timestamp: Date.now(),
          metadata:  {
            ...metadata,
            ...(humanSend ? { humanSendId: humanSend.sendId, humanSendIds: this.humanSendIds(humanSend), humanSendEnqueuedAtMs: humanSend.enqueuedAtMs } : {}),
            ...(deferredStalls.length ? { completionEntries: regularCompletions } : {}),
            source: metadata?.source || 'backend',
            inputSource: inputSource || 'keyboard',
          },
        } as any;
        if (Array.isArray(metadata?.parentInputWait) && metadata.parentInputWait.length) {
          injectSteer(state as any, inputMessage, {
            recorder: this.parentInputWaitRecorder,
            onConsumed: this.parentInputAcknowledger(channelId, threadId, metadata.parentInputWait, metadata, completionConsumption),
          });
        } else DeferredStallInput.appendActionable(state, inputMessage);
        if (humanSend) this.acceptHumanSend(channelId, threadId, humanSend);
      }

      // Resume from current node if the agent was waiting for user input
      const resumeNodeId = state.metadata.waitingForUser === true
        ? String(state.metadata.currentNodeId || '').trim()
        : '';
      const shouldResumeFromCurrentNode = !!resumeNodeId &&
        resumeNodeId !== 'input_handler' &&
        resumeNodeId !== 'output';

      // Reset execution counters for this run (but NOT messages — those accumulate)
      this.prepareFreshTurn(state);

      const startNode = shouldResumeFromCurrentNode ? resumeNodeId : 'input_handler';
      const newHumanSelection = !parkedIdentity && metadata?.workerMappingNewHumanTurn && !wasActiveForWorkerMapping && !shouldResumeFromCurrentNode;
      if (newHumanSelection && (state.metadata as any).workerModelRoute && (state.metadata as any).delegatedJobId) {
        const terminal = await parkedAgentRehydrator.isTerminalDelegatedThread(threadId);
        assertDecisionOwner();
        if (terminal) detachTerminalWorkerChat(state);
      }
      if (newHumanSelection && !(state.metadata as any).delegatedJobId) {
        const route = (state.metadata as any).workerModelChatOverride ? undefined : await workerModelRouting.newRoute(agentId);
        assertDecisionOwner();
        installWorkerRoute(state, route);
      }
      // Front-door repair channels stay in the VM during the staged rollout,
      // even if an old client sends a container override or its bound agent row changes.
      // Nothing can run in the guest on the Sulla runtime; there every agent runs in a container.
      const runLocation = this.resolveRunLocation(state, channelId);
      const tracedProvider = String(state.metadata.agent?.provider || '').trim();
      firstRunTrace('chat', 'chat started', { providerId: tracedProvider || 'primary', runLocation, channelId });
      const normalizedProvider = tracedProvider.toLowerCase();
      const timingProvider: TurnTimingProvider = normalizedProvider === 'codex'
        ? 'codex'
        : normalizedProvider.includes('claude')
          ? 'claude'
          : ['openai', 'anthropic', 'api'].includes(normalizedProvider) ? 'api' : 'other';
      const selectedModel = state.metadata.agent?.model;
      const model = timingProvider === 'codex' || timingProvider === 'claude'
        ? cliPinnedModelId(normalizedProvider, selectedModel) ?? null
        : typeof selectedModel === 'string' && selectedModel.trim() ? selectedModel.trim() : null;
      const runId = randomUUID();
      const timingContext = new TurnTimingDispatchContext(state.metadata as any, channelId, triggerType, HEARTBEAT_CHANNEL_ID);
      turnTiming = new TurnTiming({
        clock: new SystemTurnTimingClock(),
        perfLog: Logging.perf,
        runId,
        surface: timingContext.surface,
        provider: timingProvider,
        model,
        threadId,
        jobId: timingContext.jobId,
        taskIndex: timingContext.taskIndex,
        startedAtMs: Date.now(),
      });
      turnTimingLifecycle = new TurnTimingDispatchLifecycle(turnTiming, state);
      (state.metadata as any).runId = runId;
      Object.defineProperty(state, '__turnTiming', { value: turnTiming, configurable: true, enumerable: false });
      // Only the claim-owned late-answer dispatch may attribute its reply.
      // Do not source this from client-provided chat metadata.
      if (decisionTurn && threadId && state.metadata.reportingSteerRevision === initialSteerRevision) {
        state.metadata.reportingDecisionFollowUp = { id: answerInputs[0].id, threadId };
      }
      if (runLocation === 'container') {
        await turnTimingLifecycle.executeGraph(() => this.runInConversationContainer(state!, channelId, threadId, () => { assertDecisionOwner(); return graph.execute(state, startNode) }, message => this.emitMessage(channelId, 'assistant_message', {
          content: message, role: 'assistant', kind: 'progress', thread_id: threadId,
        }), runAbort?.signal, assertDecisionOwner), runAbort?.signal);
      } else {
        assertDecisionOwner();
        await turnTimingLifecycle.executeGraph(() => graph.execute(state, startNode), runAbort?.signal);
      }
      assertDecisionOwner();
      await awaitSteerAcknowledgements(state as any);
      // A completion steer still pending at the graph boundary was not seen;
      // leave it for the existing post-run continuation. All other entries
      // are committed only after this successful graph consumed the input.
      const pendingCompletionIds = new Set((state.messages as any[]).flatMap(message =>
        message?.metadata?.steerPending === true && Array.isArray(message?.metadata?.completionEntries)
          ? message.metadata.completionEntries.map((entry: PendingCompletion) => CompletionKey.of(entry))
          : []));
      for (const entry of decisionTurn ? [] : this.claimedCompletionEntries(state, metadata)) {
        if (!completionConsumption.hasPending(entry)) continue;
        if (pendingCompletionIds.has(CompletionKey.of(entry))) continue;
        if (CompletionKey.isTaskCompletion(entry)) await agentJobProvider.jobs.markTaskCompletionFirstDelivered(entry.jobId, entry.taskIndex, Date.now());
        await agentJobProvider.completionAcknowledgements.acknowledge(entry);
        completionConsumption.confirmConsumed([entry]);
      }
      for (const message of state.messages as any[]) {
        if (!decisionTurn && message?.metadata?.source === 'sub_agent_completion' && !message.metadata.steerPending) delete message.metadata.completionEntries;
      }
      if (decisionTurn) {
        const { decisionService } = await import('./DecisionService');
        await decisionService.finishAnswers(answerInputs, threadId, true);
      }
      turnConsumedInput = true;
      completionConsumption.confirmSeen();
    } catch (err: any) {
      turnOutcome = err?.name === 'AbortError' ? 'aborted' : 'error';
      turnTimingLifecycle?.setOutcome(turnOutcome);
      if (err?.name === 'AbortError' && state) {
        // Cleanly aborted by user. If a newer run superseded this one, leave
        // the shared thread state alone so the new run is not poisoned.
        if (isCurrentRun()) {
          state.metadata.cycleComplete = true;
          state.metadata.waitingForUser = true;
        }
      } else if (err?.name !== 'AbortError') {
        console.error(`[BackendGraphWS] Agent execution FAILED on ${ channelId }:`, err);
        // The turn is over even though it failed (including failures before
        // the graph ran). Leaving cycleComplete false kept the thread "busy"
        // and its chat heartbeat paused forever.
        if (state && isCurrentRun()) {
          state.metadata.cycleComplete = true;
          state.metadata.waitingForUser = true;
        }
        // Launch errors are already written for the user; the detail is in the log.
        const content = err?.name === 'AgentLaunchError'
          ? (err.retryable ? `${ err.message }. Please try again in a minute.` : err.message)
          : `Agent error: ${ err.message || String(err) }`;
        firstRunTrace('chat', 'chat error surfaced', {
          shown: content,
          ...new ChatErrorDiagnostics().describe(err, {
            channelId, threadId, agentId, state, wakeTurnJobId: wakeTurnToRepark?.jobId, wakeTurnTaskIdx: wakeTurnToRepark?.taskIndex,
          }),
        });
        this.emitMessage(channelId, 'assistant_message', {
          content,
          role:      'assistant',
          thread_id: threadId,
          runEnded:  true,
        });
      }
    } finally {
      try { turnTimingLifecycle?.finish() } catch { /* perf logging must not change turn settlement */ }
      if (state && isCurrentRun()) delete state.metadata.reportingDecisionFollowUp;
      if (decisionTurn && !turnConsumedInput) {
        try { const { decisionService } = await import('./DecisionService'); await decisionService.finishAnswers(answerInputs, threadId, false) } catch { /* Lease recovery restores the saved answer without replaying it. */ }
      }
      await (async() => {
        if (isCurrentRun()) {
          if (state) await awaitSteerAcknowledgements(state as any);
          if (state && runAbort?.signal.aborted) this.releaseUnconsumedParentInputSteers(state);
          if (turnConsumedInput) {
          // An orchestrator job message (send_job_message waking a parked
          // manager) is acked only now, after the turn it was handed to
          // actually ran — not when wakeParkedAgent was first called. A turn
          // that never reached graph.execute leaves the message pending so
          // it is redelivered rather than lost.
            const boundaryAcknowledgedIds = new Set((Array.isArray(metadata?.parentInputWait) ? metadata.parentInputWait : [])
              .filter((wait: ParentInputWaitRecord) => wait.kind === 'orchestrator')
              .map((wait: ParentInputWaitRecord) => wait.inputId));
            const jobMessageIds = [
              ...(typeof metadata?.jobMessageId === 'string' && !boundaryAcknowledgedIds.has(metadata.jobMessageId) ? [metadata.jobMessageId] : []),
              ...(Array.isArray(metadata?.jobMessageIds) ? metadata.jobMessageIds.filter((id: unknown): id is string => typeof id === 'string' && !boundaryAcknowledgedIds.has(id)) : []),
            ];
            const jobMessageThreadId = typeof metadata?.jobMessageThreadId === 'string' ? metadata.jobMessageThreadId : '';
            if (jobMessageIds.length && jobMessageThreadId) {
              await AgentJobMessagingModel.markMessagesDelivered(jobMessageIds, jobMessageThreadId);
            }
          } else {
            completionConsumption.confirmAnswered(state?.messages ?? []);
            if (!runAbort?.signal.aborted) {
              const handedCompletions = (state?.messages ?? []).flatMap((message: any) =>
                message?.metadata?.steerPending === true
                  && Array.isArray(message?.metadata?.parentInputWait)
                  && message.metadata.parentInputWait.some((wait: ParentInputWaitRecord) => wait.kind === 'completion')
                  ? message.metadata.completionEntries ?? []
                  : []);
              completionConsumption.handoff(handedCompletions);
            }
            await completionConsumption.releaseOnAbort(async entry => {
              if (runAbort?.signal.aborted) requeueAgentCompletionQuietly(channelId, threadId, entry);
              else requeueAgentCompletionAfterFailure(channelId, threadId, entry);
              await agentJobProvider.completionAcknowledgements.release(entry);
            });
            for (const message of state?.messages ?? []) {
              if (message.metadata?.source === 'sub_agent_completion' && !message.metadata.steerPending) delete message.metadata.completionEntries;
            }
          }
          // Truthful status: a dormant parked job this turn woke is re-parked
          // now unless the turn itself completed/failed/stopped it (parkTask
          // only acts while the job is still 'running', so this is a no-op then).
          // A return_result made during the turn is settled and delivered here
          // instead: no spawn_agent runner is left to hand it to the parent.
          if (wakeTurnToRepark) await agentJobLifecycle.endDormantWakeTurn(wakeTurnToRepark.jobId, wakeTurnToRepark.taskIndex);
          if (decisionTurn && !isCurrentRun()) return;
          this.activeAborts.delete(abortKey);
          if (this.activeCompletionConsumptions.get(abortKey) === completionConsumption) this.activeCompletionConsumptions.delete(abortKey);
          this.resumeContexts.delete(abortKey);
          releaseChatActivity(`graph:${ abortKey }`);

          // An unconsumed active inbox steer is carried into the explicit
          // continuation below. Flushing its durable row here would launch a
          // second graph on the same thread and duplicate the message.
          const inboxSteerPending = !runAbort?.signal.aborted && (state?.messages ?? []).some((message: any) =>
            message?.metadata?.steerPending === true
              && Array.isArray(message?.metadata?.parentInputWait)
              && message.metadata.parentInputWait.some((wait: ParentInputWaitRecord) => wait.kind === 'agent_inbox'));
          if (!inboxSteerPending) {
            await this.agentInbox?.flush({ channel: channelId, threadId, agentId })
              .catch(err => console.error('[BackendGraphWS] Failed to flush agent inbox:', err));
          }

          if (decisionTurn && this.activeAborts.has(abortKey)) return;

          // Keep a durable transcript for tabs that mount after their first run
          // has already started or completed. The renderer can hydrate this
          // snapshot before it begins consuming live events.
          if (state) {
            try {
              await saveThreadState(state);
            } catch (error) {
              console.error(`[BackendGraphWS] Failed to save thread ${ threadId } after dispatch:`, error);
            }
          }

          if (decisionTurn && this.activeAborts.has(abortKey)) return;

          // A steer that landed after the agent's last look at the transcript
          // would otherwise sit unread in an idle thread. Run it as a new turn.
          // Skipped when the run was stopped by the user — stop means stop.
          const leftovers = state && !runAbort?.signal.aborted ? takePendingSteers(state as any) : [];
          const completions = !runAbort?.signal.aborted ? takeAgentCompletions(channelId, threadId) : [];
          if (leftovers.length || completions.length) {
            const completionSteers = leftovers.filter(message => DeferredStallInput.read(message)
              || (message.metadata?.source === 'sub_agent_completion' && Array.isArray(message.metadata.completionEntries)));
            const leftoverCompletionEntries: PendingCompletion[] = completionSteers.flatMap(message =>
              DeferredStallInput.read(message)?.entries ?? message.metadata?.completionEntries ?? []);
            const allCompletions = [...new Map([...leftoverCompletionEntries, ...completions].map(entry => [CompletionKey.of(entry), entry])).values()];
            const parentInputWait = leftovers.flatMap((message: any) => Array.isArray(message.metadata?.parentInputWait) ? message.metadata.parentInputWait : []);
            const jobMessageIds = parentInputWait.filter((wait: ParentInputWaitRecord) => wait.kind === 'orchestrator').map((wait: ParentInputWaitRecord) => wait.inputId);
            const inboxMessageIds = parentInputWait.filter((wait: ParentInputWaitRecord) => wait.kind === 'agent_inbox').map((wait: ParentInputWaitRecord) => wait.inputId);
            // Completion text is rebuilt at handoff so an expired advisory cannot slip through as plain text.
            const userLeftovers = leftovers.filter(message => !completionSteers.includes(message));
            const text = userLeftovers.map(steerText).filter(Boolean).join('\n\n');
            const images = leftovers.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === 'image') : []);
            const fileReferences = leftovers.flatMap((message:any) => Array.isArray(message.metadata?.fileReferences) ? message.metadata.fileReferences : []);
            const continuationSendIds = [...new Set(userLeftovers.flatMap((message: any) => {
              if (Array.isArray(message.metadata?.humanSendIds)) return message.metadata.humanSendIds.filter((id: unknown): id is string => typeof id === 'string');
              return typeof message.metadata?.humanSendId === 'string' ? [message.metadata.humanSendId] : [];
            }))].filter(id => /^[A-Za-z0-9_.:-]{1,128}$/.test(id)).slice(0, 101);
            const enqueuedAtTimes = userLeftovers.map((message: any) => message.metadata?.humanSendEnqueuedAtMs)
              .filter((value: unknown): value is number => typeof value === 'number' && Number.isFinite(value));
            const continuationSend: HumanSendDispatch | undefined = continuationSendIds.length ? {
              sendId: continuationSendIds[0],
              ...(continuationSendIds.length > 1 ? { coalescedSendIds: continuationSendIds.slice(1) } : {}),
              route: 'new_turn',
              path: 'sent_fresh',
              enqueuedAtMs: enqueuedAtTimes.length ? Math.min(...enqueuedAtTimes) : Date.now(),
            } : undefined;
            console.log(`[BackendGraphWS] ${ leftovers.length } steer(s) arrived as thread ${ threadId } finished — running them as a follow-up turn`);
            this.dispatchToAgent(channelId, triggerType, text || (allCompletions.length ? '' : '(attached)'), threadId, scopedWorkflowId, overrideAgentId, inputSource, {
              source: allCompletions.length ? 'sub_agent_completion' : 'turn_continuation',
              ...(images.length || fileReferences.length ? { attachments: images, fileReferences } : {}),
              ...(continuationSend ? { humanSend: continuationSend } : {}),
              ...(allCompletions.length ? { completionEntries: allCompletions, renderCompletionEntries: true } : {}),
              ...(parentInputWait.length ? { parentInputWait } : {}),
              ...(parentInputWait.length ? { parentInputWaitBoundary: 'followup' } : {}),
              ...(jobMessageIds.length ? { jobMessageIds, jobMessageThreadId: threadId } : {}),
              ...(inboxMessageIds.length ? { inboxMessageIds } : {}),
            })
              .catch(err => console.error('[BackendGraphWS] Failed to dispatch follow-up steer:', err));
          } else if (!runAbort?.signal.aborted && (turnConsumedInput || metadata?.source !== 'orchestrator_job_message')) {
          // An orchestrator message that arrived while this thread was busy
          // (wakeParkedAgent or dispatchToAgent's own busy-guard declined to
          // dispatch for it) is not a steer and would otherwise be stranded
          // once this run ends with activeAborts clear. Redeliver anything
          // still pending now that the thread is idle again. A failed delivery
          // keeps its messages pending without immediately retrying itself.
            const pendingJobMessages = await AgentJobMessagingModel.pendingMessagesForThread(threadId).catch(err => {
              console.warn('[BackendGraphWS] Failed to check for stranded orchestrator messages:', (err as Error).message);
              return [];
            });
            if (pendingJobMessages.length) {
              const text = pendingJobMessages.map(entry => entry.message).join('\n\n');
              console.log(`[BackendGraphWS] ${ pendingJobMessages.length } orchestrator message(s) arrived while thread ${ threadId } was busy — running them as a follow-up turn`);
              this.dispatchToAgent(channelId, triggerType, `[Message from orchestrator]\n${ text }`, threadId, scopedWorkflowId, overrideAgentId, inputSource, {
                source: 'orchestrator_job_message', jobMessageIds: pendingJobMessages.map(entry => entry.id), jobMessageThreadId: threadId,
              })
                .catch(err => console.error('[BackendGraphWS] Failed to dispatch follow-up orchestrator message:', err));
            }
          }
        }
      })();
    }
    return turnConsumedInput ? 'accepted' : 'failed';
  }

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  private emitMessage(channelId: string, type: string, data: unknown): void {
    this.wsService.send(channelId, { type, data, timestamp: Date.now() });
  }

  private async registerAgent(channelId: string, name: string, description: string): Promise<void> {
    const { getActiveAgentsRegistry } = await import('./ActiveAgentsRegistry');
    const registry = getActiveAgentsRegistry();
    await registry.register({
      agentId:      channelId,
      name,
      role:         description,
      channel:      channelId,
      type:         channelId === HEARTBEAT_CHANNEL_ID ? 'heartbeat' : 'agent',
      status:       'running',
      startedAt:    Date.now(),
      lastActiveAt: Date.now(),
      description,
    });
  }

  /** Remove registrations written by built-in agents retired in newer releases. */
  private async deregisterAgent(agentId: string): Promise<void> {
    const { getActiveAgentsRegistry } = await import('./ActiveAgentsRegistry');
    await getActiveAgentsRegistry().deregister(agentId);
  }

  // ------------------------------------------------------------------
  // Calendar handling (unchanged)
  // ------------------------------------------------------------------

  private handleCalendarMessage(msg: WebSocketMessage): void {
    const calendarMsg = msg as CalendarWebSocketMessage;

    if (!calendarMsg || typeof calendarMsg.type !== 'string') {
      console.warn('[BackendGraphWS] Invalid calendar message format:', calendarMsg);
      return;
    }

    const { type, event } = calendarMsg;

    if (type === 'scheduled' && event) {
      try {
        this.schedulerService.scheduleEvent(event);
      } catch (err) {
        console.error('[BackendGraphWS] Failed to schedule calendar event:', err);
      }
    } else if (type === 'cancel' && event?.id) {
      try {
        this.schedulerService.cancelEvent(event.id);
      } catch (err) {
        console.error('[BackendGraphWS] Failed to cancel calendar event:', err);
      }
    } else if (type === 'reschedule' && event) {
      try {
        this.schedulerService.rescheduleEvent(event);
      } catch (err) {
        console.error('[BackendGraphWS] Failed to reschedule calendar event:', err);
      }
    }
  }
}

interface CalendarWebSocketMessage {
  type:      'scheduled' | 'cancel' | 'reschedule';
  event?:    CalendarEventData;
  id:        string;
  timestamp: number;
  channel:   string;
}
