// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// BackendGraphWebSocketService.ts
// Main-process agent dispatcher: routes messages on the sulla-desktop and
// heartbeat channels to the default agent via GraphRegistry.
import { toolRegistry } from '@pkg/agent/tools/registry';
import { SUPPORT_TOOL_NAMES } from '@pkg/agent/tools/support/manifests';
import { AbortService } from './AbortService';
import { recoverPendingAgentCompletions } from './AgentCompletionRecoveryService';
import { enqueueAgentCompletion, formatCompletionBatch, registerCompletionIdleDispatcher, releaseAgentCompletionClaim, requeueAgentCompletionAfterFailure, requeueAgentCompletionQuietly, setCompletionInboxStopped, takeAgentCompletions, type PendingCompletion } from './AgentCompletionInbox';
import { CompletionKey } from '../app/Services/CompletionKey';
import { acquireWhenReady, executeWithContainerLifecycleRecovery } from './ContainerLifecycleRecovery';
import { applyThreadAgentRoute, resolveDefaultRouteAgent, SULLA_DESKTOP_CHANNEL_ID, type RoutableAgent } from './ChatAgentRouting';
import { agentDefinitionService } from './AgentDefinitionService';
import { GraphRegistry, getAgentIdForTrigger, nextThreadId, nextMessageId } from './GraphRegistry';
import { InterruptedAgentRecoveryService } from './InterruptedAgentRecoveryService';
import { agentWaitProvider } from './AgentWaitServices';
import { RunActivity } from './RunActivity';
import { agentJobLifecycle, returnedTaskSettlement } from './AgentJobLifecycleService';
import { parkedAgentRehydrator } from './ParkedAgentRehydrator';
import { ChatErrorDiagnostics } from './ChatErrorDiagnostics';
import { ThreadModelOverridePolicy } from './ThreadModelOverridePolicy';
import { acquireChatActivity, releaseChatActivity } from '@pkg/main/SleepPreventionService';
import { getSchedulerService } from './SchedulerService';
import { getWebSocketClientService, type WebSocketMessage } from './WebSocketClientService';
import { loadThreadState, saveThreadState } from '../nodes/ThreadStateStore';
import { injectSteer, steerText, takePendingSteers } from '../utils/steerChannel';
import { resolveAgentIdentity } from '../utils/agentIdentity';
import { cleanVoiceTurnId } from '../utils/voiceTurn';
import { cliPinnedModelId } from '../languagemodels/ModelTierResolver';
import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { DelegatedCompletionHandoff } from '../app/Services/DelegatedCompletionHandoff';
import { AgentJobMessagingModel } from '../database/models/AgentJobMessagingModel';
import { AgentInbox, type AgentInboxDeliveryReceipt, type AgentInboxEntry, type AgentInboxRepository, type AgentInboxTarget } from './AgentInbox';
import { PostgresAgentInboxRepository } from '../app/Repositories/PostgresAgentInboxRepository';
import { DurableAgentInboxReceiverResolver, type AgentInboxReceiverResolver } from './AgentInboxReceiverResolver';
import { DesktopPostgresConnection } from '../app/Database/DesktopPostgresConnection';
import { postgresClient } from '../database/PostgresClient';

import { frontendGraphLogger as console } from '@pkg/agent/utils/agentLogger';
import { firstRunTrace } from '@pkg/utils/firstRunTraceSink';
import { DelegatedTurnPreparer } from './DelegatedTurnPreparer';
import { ReceiverRunGuard } from './ReceiverRunGuard';
import { CompletionConsumptionRecorder } from './CompletionConsumptionRecorder';
import { AgentTurnStopper } from './AgentTurnStopper';
import { AgentRunLocationResolver } from './AgentRunLocationResolver';
import { DesktopOrgCloudSession } from './CloudOrgMessagingTransport';
import { DesktopOrgMessengerFactory } from './DesktopOrgMessengerFactory';
import { OrgMembershipDirectory, type OrgMembership } from './OrgMembershipDirectory';
import { OrgMessengerFleet } from './OrgMessengerFleet';
import type { OrgConversationStartRequest } from './OrgMessenger';
import type { MessageEnvelope } from '@sulla/domain';
import { OrgContactRequestDecisionPrompter } from './OrgContactRequestDecisionPrompter';
import { PostgresOrgMessagingStateRepository } from '../app/Repositories/PostgresOrgMessagingStateRepository';

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
    backendGraphWebSocketServiceInstance = new BackendGraphWebSocketService();
  }
  return backendGraphWebSocketServiceInstance;
}

export class BackendGraphWebSocketService {
  private readonly runLocationResolver = new AgentRunLocationResolver();
  private readonly wsService = getWebSocketClientService();
  private readonly schedulerService = getSchedulerService();
  private unsubscribes: (() => void)[] = [];
  // Keyed by `${channelId}|${threadId}` so concurrent threads on the same
  // channel (e.g. multiple chat tabs sharing the desktop WebSocket) can
  // run in parallel. Previously this was keyed by channelId alone, which
  // made every new tab message abort the prior tab's still-running graph.
  private activeAborts = new Map<string, AbortService>();
  private suspendedRuns = new Set<string>();
  private readonly agentInbox: AgentInbox;
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
    provider: string;
    model?: string;
    agentId: string;
    lifecycle: import('./AgentContainerLauncher').AgentContainerLifecycle;
    idleTimer: ReturnType<typeof setTimeout>;
  }>();
  private conversationContainerStarts = new Map<string, Promise<import('./AgentContainerLauncher').AgentContainerLifecycle>>();

  private hasActiveRunOnAnotherChannel(channelId: string, threadId: string): boolean {
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
      injectSteer(delegated.state, {
        id:        nextMessageId(),
        role:      'user',
        content:   `[Message from orchestrator]\n${ message }`,
        timestamp: Date.now(),
        metadata:  { source: 'orchestrator_job_message', inputSource: 'system', ...messageMeta },
      } as any);
      agentJobLifecycle.wake(threadId);
      return true;
    }
    // The worker can persist its wait just before spawn_agent registers the
    // in-process waiter. Keep this wake on the same graph: inject now and
    // latch the wake for waitForWake() to consume once settlement begins.
    if (delegated && (delegated.state.metadata as any)?.delegatedRunActive) {
      injectSteer(delegated.state, {
        id:        nextMessageId(),
        role:      'user',
        content:   `[Message from orchestrator]\n${ message }`,
        timestamp: Date.now(),
        metadata:  { source: 'orchestrator_job_message', inputSource: 'system', ...messageMeta },
      } as any);
      agentJobLifecycle.wake(threadId);
      return true;
    }
    // A turn already in flight for this thread through dispatchToAgent
    // itself (a prior dormant wake still running). Dispatching here would
    // abort that live run out from under it. The message was already written
    // to agent_job_messages by the caller before this call, so it is safe to
    // leave it queued: the active run's own finally block redelivers any
    // message still pending once it ends (see dispatchToAgent), or a CLI
    // sub-agent picks it up at its next model-call boundary if the run keeps
    // going.
    if (this.hasActiveRun(channelId, threadId)) {
      console.warn(`[BackendGraphWS] Deferred orchestrator wake for thread ${ threadId }: a turn is already running; the message stays queued for its next turn.`);
      return false;
    }
    const receipt = await this.dispatchToAgent(channelId, channelId === HEARTBEAT_CHANNEL_ID ? 'heartbeat' : 'sulla-desktop',
      `[Message from orchestrator]\n${ message }`, threadId, undefined, agentId || parked.agentId, 'system', {
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

  private async runInConversationContainer<T>(state: AgentGraphState, channelId: string, threadId: string, action: () => T, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<Awaited<T>> {
    const { modelRouter } = await import('../languagemodels/modelRouter');
    const routedAgentId = resolveAgentIdentity(state.metadata);
    const definition = routedAgentId ? await agentDefinitionService.findBySlug(routedAgentId).catch(() => null) : null;
    const { effectiveModelChoice } = await import('../languagemodels/threadModelChoice');
    const choice = effectiveModelChoice({ provider: state.metadata.agent?.provider, model: state.metadata.agent?.model, metadata: state.metadata, agentChoice: definition?.model_choice });
    const routed = (await modelRouter.resolve('agents', choice))[0];
    const provider = String(routed?.provider || state.metadata.agent?.provider || '').trim();
    return executeWithContainerLifecycleRecovery(
      () => acquireWhenReady(() => this.conversationContainer(channelId, threadId, provider, state), message => onProgress?.(message), signal),
      lost => this.recoverConversationContainer(channelId, threadId, provider, state, lost),
      action,
    );
  }

  constructor(private readonly turnPreparer = new DelegatedTurnPreparer(), dependencies: { inboxRepository?: AgentInboxRepository; inboxReceiverResolver?: AgentInboxReceiverResolver; inboxRunGuard?: ReceiverRunGuard } = {}) {
    const repository = dependencies.inboxRepository ?? new PostgresAgentInboxRepository(new DesktopPostgresConnection(postgresClient));
    this.inboxRunGuard = dependencies.inboxRunGuard ?? new ReceiverRunGuard();
    this.inboxReceiverResolver = dependencies.inboxReceiverResolver ?? new DurableAgentInboxReceiverResolver(
      agentJobProvider.jobs,
      channel => this.inboxThread({ channel }) ?? GraphRegistry.findThreadByChannel(channel),
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
      { take: takeAgentCompletions, format: formatCompletionBatch },
      agentJobLifecycle,
      {
        firstDelivered: entry => agentJobProvider.jobs.markTaskCompletionFirstDelivered(entry.jobId, entry.taskIndex, Date.now()),
        acknowledge:    entry => agentJobProvider.completionAcknowledgements.acknowledge(entry),
      },
      (state, message) => { injectSteer(state as any, message) },
      nextMessageId,
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
    if (target.threadId && this.hasActiveRun(target.channel, target.threadId)) return target.threadId;
    const prefix = `${ target.channel }|`;
    return [...this.activeAborts.keys()].find(key => key.startsWith(prefix))?.slice(prefix.length);
  }

  private async wakeInbox(target: AgentInboxTarget, batch: string, entries: AgentInboxEntry[]): Promise<AgentInboxDeliveryReceipt> {
    const threadId = target.threadId || this.inboxThread(target);
    return await this.dispatchToAgent(
      target.channel,
      target.channel === HEARTBEAT_CHANNEL_ID ? 'heartbeat' : 'sulla-desktop',
      batch,
      threadId,
      undefined,
      target.agentId,
      'system',
      { source: 'agent_inbox', inboxMessageIds: entries.map(entry => entry.envelope.ids.messageId), relayed: entries.some(entry => entry.envelope.ids.relayed === true) },
    );
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
    if (this.hasActiveRun(channelId, threadId)) return;
    const delegated = GraphRegistry.get(threadId);
    // A runner-owned delegated manager (parked or mid-turn) gets the batch
    // injected and its runner woken; never a second, disconnected turn.
    if (await this.delegatedCompletionHandoff.deliver(channelId, threadId, delegated?.state as any)) return;
    const entries = takeAgentCompletions(channelId, threadId);
    if (!entries.length) return;
    const content = formatCompletionBatch(entries);
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
      return this.dispatchToAgent(channelId, triggerType, content, threadId, undefined, threadAgentId, 'system', {
        source: 'sub_agent_completion', completionEntries: entries,
      });
    }).catch(err => {
      // Requeue (enqueue would drop these claimed entries as duplicates) with
      // backoff, so a persistent failure is retried later, not hot-looped.
      for (const entry of entries) requeueAgentCompletionAfterFailure(channelId, threadId, entry);
      console.error('[BackendGraphWS] Failed to dispatch completion batch:', err);

    });
  }

  dispose(): void {
    this.orgMessagingAbort?.abort();
    this.orgMessagingAbort = undefined;
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
      const start = this.createOrReuseConversationContainer(channelId, threadId, provider, state, key);
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
  ): Promise<import('./AgentContainerLauncher').AgentContainerLifecycle> {
    const existing = this.conversationContainers.get(key);
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
    if (existing && !existing.lifecycle.closed && existing.agentId === agentId && ((existing.provider === provider && pinned(existing.model) === pinned(model)) || inUse)) {
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
    const { createAgentContainerLifecycle } = await import('./AgentContainerLauncher');
    const lifecycle = await createAgentContainerLifecycle({
      jobId: `chat-${ threadId }`, taskIndex: 0, provider,
      model, state,
      persistenceKey: conversationPersistenceKey(channelId, threadId, state),
    });
    const idleTimer = this.armConversationIdle(key, lifecycle);
    this.conversationContainers.set(key, { provider, model, agentId, lifecycle, idleTimer });
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
    if (current?.lifecycle === lost) {
      clearTimeout(current.idleTimer);
      this.conversationContainers.delete(key);
    }
    await lost.close('container-disappeared', 'BackendGraphWebSocketService.recoverConversationContainer')
      .catch(error => console.warn('[BackendGraphWS] Failed to close vanished conversation container:', error));
    console.warn(`[BackendGraphWS] Rebuilding vanished conversation container for ${ key }; retrying the same provider`);
    return await this.conversationContainer(channelId, threadId, provider, state);
  }

  /**
   * Tear down and re-establish all WebSocket channel subscriptions.
   * Called after system resume to ensure the backend graph executor
   * re-registers its message handlers on the freshly reconnected sockets.
   */
  reinitialize(): void {
    console.log('[BackendGraphWS] reinitialize — re-subscribing to all channels after system resume');
    this.dispose();
    this.initialize();
  }

  private initialize(): void {
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

    // Subscribe to every enabled custom-agent channel stored in Postgres.
    this.subscribeToAgentChannels().catch(err =>
      console.warn('[BackendGraphWS] Failed to subscribe to agent channels:', err));

    // The database-backed completion outbox must replay only after the graph
    // channels are subscribed; otherwise a recovered wake can be emitted into
    // an empty in-process bus and incorrectly acknowledged as delivered.
    recoverPendingAgentCompletions().catch(err =>
      console.warn('[BackendGraphWS] Failed to recover agent completions:', err));
    this.agentInbox.replayPending().catch(err =>
      console.warn('[BackendGraphWS] Failed to replay pending agent inbox messages:', err));
    const interruptedRecovery = new InterruptedAgentRecoveryService(
      agentJobProvider.states,
      async(job, taskIndex) => {
        const task = job.tasks[taskIndex];
        const channel = job.parentChannel || 'sulla-desktop';
        await this.dispatchToAgent(channel, channel === HEARTBEAT_CHANNEL_ID ? 'heartbeat' : 'sulla-desktop',
          `[Runtime restart recovery]\nThe previous runtime stopped while this delegated task was running. Continue from the durable thread state, preserve the original contract, and call return_result exactly once when finished.`,
          task.threadId, undefined, task.agentId, 'system', { source: 'runtime_restart_recovery', delegatedJobId: job.jobId });
      },
      (job, reason) => {
        if (!job.parentChannel || !job.parentThreadId) return;
        enqueueAgentCompletion(job.parentChannel, job.parentThreadId, { jobId: job.jobId, taskIndex: -1, results: [], failureReason: reason });
      },
    );
    interruptedRecovery.recover().catch(err => console.warn('[BackendGraphWS] Failed to recover interrupted agent jobs:', err));
    agentWaitProvider.scheduler.start().catch(err => console.warn('[BackendGraphWS] Failed to recover delegated task waits:', err));
    // No spawn_agent runner survives a restart, so a return recorded by a
    // runner that died (or by a dormant wake turn that predates this fix)
    // would otherwise never reach its parent.
    returnedTaskSettlement.settleStranded()
      .then(count => { if (count) console.log(`[BackendGraphWS] Settled ${ count } returned delegated task(s) left without a runner`); })
      .catch(err => console.warn('[BackendGraphWS] Failed to settle stranded returned tasks:', err));
    if ((process as any).type === 'browser') {
      this.orgMessagingAbort?.abort();
      this.orgMessagingAbort = new AbortController();
      this.orgMessengerFleet.run(this.orgMessagingAbort.signal).catch(error => console.warn('[BackendGraphWS] Org messaging stopped unexpectedly:', error));
    }
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
      console.error(`[BackendGraphWS] ${ msg.type } on ${ channelId } failed before the agent started:`, err);
      if (msg.type !== 'user_message' && msg.type !== 'inject_message') return;
      const data = typeof msg.data === 'string' ? {} : (msg.data as any);
      const threadId = typeof data?.threadId === 'string' ? data.threadId : undefined;
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
      this.activeAborts.get(this.abortKey(channelId, stopThreadId))?.abort();
      setCompletionInboxStopped(channelId, stopThreadId, true);
      return;
    }

    if (msg.type === 'agent_inbox_message') {
      const data = typeof msg.data === 'string' ? {} : (msg.data as any);
      const envelope = data?.envelope;
      if (!envelope?.ids?.messageId || !envelope?.body || envelope?.kind !== 'peer') return;
      const target = await this.inboxReceiverResolver.resolve(channelId);
      await this.agentInbox.receive({
        envelope,
        target,
      });
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

    // ── Inject message into running graph state (no execution trigger) ──
    if (msg.type === 'inject_message') {
      const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data as any);
      const content = (data?.content ?? '').trim();
      const threadId = data?.threadId as string | undefined;
      if (!content || !threadId) return;

      // Only a thread with a run in flight can absorb a steer. A registered
      // but idle graph would just hold the message with nobody to read it.
      const existing = this.activeAborts.has(this.abortKey(channelId, threadId)) ? GraphRegistry.get(threadId) : undefined;
      if (existing) {
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
          id:        nextMessageId(),
          role:      'user',
          content:   messageContent,
          timestamp: Date.now(),
          metadata:  {
            ...data?.metadata,
            source: data?.metadata?.source || 'inject',
            inputSource: data?.metadata?.inputSource || 'keyboard',
          },
        } as any);
        console.log(`[BackendGraphWS] Steered running thread ${ threadId }: ${ content.slice(0, 50) }...`);
        return;
      }

      // Graph not found — fall through to full dispatch (triggers execution)
      console.log(`[BackendGraphWS] inject_message: no running state for thread ${ threadId }, falling back to full dispatch`);
    }

    if (msg.type !== 'user_message' && msg.type !== 'inject_message') return;

    const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data as any);
    const content = (data?.content ?? '').trim();
    const hasAttachments = Array.isArray(data?.metadata?.attachments) && data.metadata.attachments.length > 0;
    if (!content && !hasAttachments) return;

    // A hidden sub-agent opened in a tab is still driven by its spawn_agent
    // runner. A message typed into that tab steers the live run; starting a
    // second execution on the same state would race the runner.
    const delegated = typeof data?.threadId === 'string' ? GraphRegistry.get(data.threadId) : undefined;
    // A sub-agent parked mid in-process wait for its own children owns that
    // turn's lifecycle the same way: inject and release its waiter instead of
    // falling through to a disconnected new dispatchToAgent turn below.
    const parkedWaiter = typeof data?.threadId === 'string' && agentJobLifecycle.hasLiveWaiter(data.threadId);
    if (content && delegated && (parkedWaiter || (delegated.state.metadata as any)?.delegatedRunActive)) {
      injectSteer(delegated.state, {
        id:        nextMessageId(),
        role:      'user',
        content,
        timestamp: Date.now(),
        metadata:  { ...data?.metadata, source: data?.metadata?.source || 'inject', inputSource: data?.metadata?.inputSource || 'keyboard' },
      } as any);
      if (parkedWaiter) agentJobLifecycle.wake(data.threadId as string);
      console.log(`[BackendGraphWS] Steered delegated run ${ data.threadId }: ${ content.slice(0, 50) }...`);
      return;
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

    await this.dispatchToAgent(channelId, _triggerType, content, threadIdFromMsg, scopedWorkflowId, overrideAgentId, inputSource, metadata);
  }

  private async dispatchToAgent(channelId: string, triggerType: string, message: string, threadIdFromMsg?: string, scopedWorkflowId?: string, overrideAgentId?: string, inputSource?: string, metadata?: Record<string, any>): Promise<AgentInboxDeliveryReceipt> {
    const completionConsumption = new CompletionConsumptionRecorder();
    const { getModelProviderService } = await import('./ModelProviderService');
    const modelProvider = getModelProviderService();
    // Before the saved model choice loads (it waits for the vault on a
    // relaunch), an empty provider is not evidence that no AI is connected.
    // Give it a minute rather than bouncing the user's first message.
    for (let waited = 0; !modelProvider.isInitialized() && channelId !== HEARTBEAT_CHANNEL_ID && waited < 60; waited++) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    if (!modelProvider.isInitialized() && channelId !== HEARTBEAT_CHANNEL_ID) {
      this.emitMessage(channelId, 'assistant_message', {
        content: 'Sulla is still starting up. Send your message again in a moment.',
        role: 'assistant', kind: 'error', thread_id: threadIdFromMsg,
      });
      firstRunTrace('chat', 'chat held: model choice not loaded yet', { channelId });
      return 'failed';
    }
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
    if (metadata?.source !== 'sub_agent_completion') {
      const pendingCompletions = takeAgentCompletions(channelId, threadId);
      if (pendingCompletions.length) {
        message = `${ message }\n\n${ formatCompletionBatch(pendingCompletions) }`;
        metadata = {
          ...metadata,
          completionEntries: pendingCompletions,
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
    const abortKey = this.abortKey(channelId, threadId);
    let runAbort: AbortService | undefined;
    // Set only for a dormant parked job (no live in-process waiter) this turn
    // is waking. Re-parked in the finally block if the turn ends without the
    // job completing, so job/task status stays truthful for the turn's whole
    // duration rather than lying 'parked' while it is actually executing.
    let wakeTurnToRepark: { jobId: string; taskIndex: number } | undefined;

    const isCurrentRun = () => this.activeAborts.get(abortKey) === runAbort;

    try {
      const result = await GraphRegistry.getOrCreateAgentGraph(agentId, threadId) as { graph: any; state: AgentGraphState };
      const graph = result.graph;
      state = result.state;
      const parkedIdentity = await parkedAgentRehydrator.resolve(threadId);
      if (parkedIdentity) parkedAgentRehydrator.apply(state, parkedIdentity);

      if (newRoute) {
        applyThreadAgentRoute(state, newRoute);
        // Persist before execution so a renderer refresh or process interruption
        // cannot lose the sticky route chosen for this thread.
        await saveThreadState(state);
      }

      // A support tab supplies an opaque session id every turn. Resolve the
      // fixed tool set here rather than trusting renderer-provided names. If an
      // active session ends, the tab omits the id and the old capability is
      // synchronously removed before this turn can execute.
      const supportSessionId = typeof metadata?.supportSessionId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(metadata.supportSessionId)
        ? metadata.supportSessionId : '';
      if (supportSessionId) {
        (state.metadata as any).supportSessionId = supportSessionId;
        const supportTabTools = [...SUPPORT_TOOL_NAMES, 'github_trigger_workflow_run'];
        (state.metadata as any).allowedToolNames = supportTabTools;
        (state.metadata as any).supportContext = typeof metadata?.supportContext === 'string' ? metadata.supportContext : '';
        (state as any).llmTools = await Promise.all(supportTabTools.map(name => toolRegistry.convertToolToLLM(name)));
      } else if ((state.metadata as any).supportSessionId) {
        delete (state.metadata as any).supportSessionId;
        delete (state.metadata as any).allowedToolNames;
        delete (state.metadata as any).supportContext;
        delete (state as any).llmTools;
      }

      // A saved/cached thread carries a historical copy of its agent config.
      // Run-location is deployment policy, so resolve it from the canonical row
      // on every dispatch before applying an explicit per-turn override.
      const currentDefinition = await agentDefinitionService.findBySlug(agentId);
      if (currentDefinition) {
        state.metadata.agent = {
          ...(state.metadata.agent ?? {}),
          runLocation: currentDefinition.run_location,
        };
      }

      // Model choices from the chat picker are scoped to this thread state;
      // they never mutate ModelProviderService or global settings.
      state.metadata.agent = new ThreadModelOverridePolicy().apply(state.metadata.agent as any, threadModelSelection);

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

      // Completion and orchestrator wakes are accumulated instead of
      // superseding the active parent. Human/new-turn messages still replace
      // the prior turn. An orchestrator wake (source 'orchestrator_job_message',
      // from wakeParkedAgent) has nothing to re-enqueue here — its message was
      // already written to agent_job_messages by the caller before this
      // dispatch, and the finally block below redelivers anything still
      // pending once the active run ends.
      if ((metadata?.source === 'sub_agent_completion' || metadata?.source === 'orchestrator_job_message' || metadata?.source === 'agent_inbox') && this.activeAborts.has(abortKey)) {
        if (metadata?.source === 'sub_agent_completion') {
          // Claimed by the caller's take: requeue clears that claim (enqueue would drop them).
          // No wake: the active run drains the inbox when it ends.
          for (const entry of metadata.completionEntries ?? []) requeueAgentCompletionQuietly(channelId, threadId, entry);
        }
        return 'deferred';
      }
      // The completion is now part of this turn's input. Persist consumption
      // before the model call so a process restart cannot replay it as new.
      for (const entry of this.claimedCompletionEntries(state, metadata)) {
        completionConsumption.recordInjected([entry]);
        await agentJobProvider.jobs.markTaskCompletionFirstDelivered(entry.jobId, entry.taskIndex, Date.now());
        await agentJobProvider.completionAcknowledgements.acknowledge(entry);
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
      }

      // Abort any prior run still in flight FOR THIS SAME THREAD before
      // starting a new one. Per-thread (not per-channel) so multiple chat
      // tabs sharing the same WebSocket channel can run in parallel.
      // Rapid double-sends from the same tab still get coalesced because
      // they share a thread id.
      const prior = this.activeAborts.get(abortKey);
      if (prior) {
        try {
          prior.abort();
        } catch {
          // already aborted
        }
        this.activeAborts.delete(abortKey);
      }

      // Create abort service for this run.
      // Set state first so stop_run can't race between activeAborts and state.
      const abort = new AbortService();
      runAbort = abort;
      state.metadata.options.abort = abort;
      this.activeAborts.set(abortKey, abort);
      this.resumeContexts.set(abortKey, {
        channelId, triggerType, threadId, scopedWorkflowId, overrideAgentId, inputSource,
      });
      acquireChatActivity(`graph:${ abortKey }`);
      // A turn starting is activity: a delegated tab that sat idle waiting on
      // its human must not read as a dead run the moment it wakes.
      RunActivity.touch(state.metadata);

      // Route responses back to the originating channel
      state.metadata.wsChannel = channelId;
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

      state.messages.push({
        id:        nextMessageId(),
        role:      'user',
        content:   messageContent,
        timestamp: Date.now(),
        metadata:  {
          ...metadata,
          source: metadata?.source || 'backend',
          inputSource: inputSource || 'keyboard',
        },
      } as any);

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
      // Front-door repair channels stay in the VM during the staged rollout,
      // even if an old client sends a container override or its bound agent row changes.
      // Nothing can run in the guest on the Sulla runtime; there every agent runs in a container.
      const runLocation = this.resolveRunLocation(state, channelId);
      const tracedProvider = String(state.metadata.agent?.provider || '').trim();
      firstRunTrace('chat', 'chat started', { providerId: tracedProvider || 'primary', runLocation, channelId });
      if (runLocation === 'container') {
        await this.runInConversationContainer(state, channelId, threadId, () => graph.execute(state, startNode), message => this.emitMessage(channelId, 'assistant_message', {
          content: message, role: 'assistant', kind: 'progress', thread_id: threadId,
        }), runAbort?.signal);
      } else {
        await graph.execute(state, startNode);
      }
      // Completion claims are acknowledged only after a successful graph turn actually consumed them.
      for (const entry of this.claimedCompletionEntries(state, metadata)) await agentJobProvider.completionAcknowledgements.acknowledge(entry);
      for (const message of state.messages as any[]) {
        if (message?.metadata?.source === 'sub_agent_completion') delete message.metadata.completionEntries;
      }
      turnConsumedInput = true;
      completionConsumption.confirmSeen();
    } catch (err: any) {
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
      if (isCurrentRun()) {
        if (turnConsumedInput) {
          // An orchestrator job message (send_job_message waking a parked
          // manager) is acked only now, after the turn it was handed to
          // actually ran — not when wakeParkedAgent was first called. A turn
          // that never reached graph.execute leaves the message pending so
          // it is redelivered rather than lost.
          const jobMessageIds = [
            ...(typeof metadata?.jobMessageId === 'string' ? [metadata.jobMessageId] : []),
            ...(Array.isArray(metadata?.jobMessageIds) ? metadata.jobMessageIds.filter((id: unknown): id is string => typeof id === 'string') : []),
          ];
          const jobMessageThreadId = typeof metadata?.jobMessageThreadId === 'string' ? metadata.jobMessageThreadId : '';
          if (jobMessageIds.length && jobMessageThreadId) {
            await AgentJobMessagingModel.markMessagesDelivered(jobMessageIds, jobMessageThreadId);
          }
        } else {
          // Results the model already answered stay acknowledged; only unseen ones go back to the inbox.
          completionConsumption.confirmAnswered(state?.messages ?? []);
          await completionConsumption.releaseOnAbort(async entry => {
            // A failed turn retries with backoff; a stopped one waits quietly (stop means stop).
            if (runAbort?.signal.aborted) requeueAgentCompletionQuietly(channelId, threadId, entry);
            else requeueAgentCompletionAfterFailure(channelId, threadId, entry);
            await agentJobProvider.completionAcknowledgements.release(entry);
          });
          for (const message of state?.messages ?? []) {
            if ((message as any)?.metadata?.source === 'sub_agent_completion') delete (message as any).metadata.completionEntries;
          }
        }
        // Truthful status: a dormant parked job this turn woke is re-parked
        // now unless the turn itself completed/failed/stopped it (parkTask
        // only acts while the job is still 'running', so this is a no-op then).
        // A return_result made during the turn is settled and delivered here
        // instead: no spawn_agent runner is left to hand it to the parent.
        if (wakeTurnToRepark) await agentJobLifecycle.endDormantWakeTurn(wakeTurnToRepark.jobId, wakeTurnToRepark.taskIndex);
        this.activeAborts.delete(abortKey);
        this.resumeContexts.delete(abortKey);
        releaseChatActivity(`graph:${ abortKey }`);

        // Error, abort and success all release queued peer messages as one follow-up batch.
        await this.agentInbox?.flush({ channel: channelId, threadId, agentId })
          .catch(err => console.error('[BackendGraphWS] Failed to flush agent inbox:', err));

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

        // A steer that landed after the agent's last look at the transcript
        // would otherwise sit unread in an idle thread. Run it as a new turn.
        // Skipped when the run was stopped by the user — stop means stop.
        const leftovers = state && !runAbort?.signal.aborted ? takePendingSteers(state as any) : [];
        const completions = !runAbort?.signal.aborted ? takeAgentCompletions(channelId, threadId) : [];
        if (leftovers.length || completions.length) {
          const leftoverCompletionEntries = leftovers.flatMap((message: any) => Array.isArray(message.metadata?.completionEntries) ? message.metadata.completionEntries : []);
          const allCompletions = [...leftoverCompletionEntries, ...completions].filter((entry, index, all) => all.findIndex(candidate => candidate.jobId === entry.jobId && candidate.taskIndex === entry.taskIndex) === index);
          const text = [leftovers.map(steerText).filter(Boolean).join('\n\n'), formatCompletionBatch(completions)].filter(Boolean).join('\n\n');
          const images = leftovers.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === 'image') : []);
          const fileReferences = leftovers.flatMap((message:any) => Array.isArray(message.metadata?.fileReferences) ? message.metadata.fileReferences : []);
          console.log(`[BackendGraphWS] ${ leftovers.length } steer(s) arrived as thread ${ threadId } finished — running them as a follow-up turn`);
          this.dispatchToAgent(channelId, triggerType, text || '(attached)', threadId, scopedWorkflowId, overrideAgentId, inputSource, {
            ...(images.length || fileReferences.length ? { attachments: images, fileReferences } : {}),
            ...(allCompletions.length ? { source: 'sub_agent_completion', completionEntries: allCompletions } : {}),
          })
            .catch(err => console.error('[BackendGraphWS] Failed to dispatch follow-up steer:', err));
        } else if (!runAbort?.signal.aborted) {
          // An orchestrator message that arrived while this thread was busy
          // (wakeParkedAgent or dispatchToAgent's own busy-guard declined to
          // dispatch for it) is not a steer and would otherwise be stranded
          // once this run ends with activeAborts clear. Redeliver anything
          // still pending now that the thread is idle again.
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
