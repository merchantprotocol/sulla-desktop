// BackendGraphWebSocketService.ts
// Main-process agent dispatcher: routes messages on the sulla-desktop, workbench,
// and heartbeat channels to the default agent via GraphRegistry.
import { AbortService } from './AbortService';
import { GraphRegistry, getAgentIdForTrigger, nextThreadId, nextMessageId } from './GraphRegistry';
import { getSchedulerService } from './SchedulerService';
import { getWebSocketClientService, type WebSocketMessage } from './WebSocketClientService';

import { frontendGraphLogger as console } from '@pkg/agent/utils/agentLogger';

import type { CalendarEventData } from './CalendarClient';
import type { AgentGraphState } from '../nodes/Graph';

const SULLA_DESKTOP_CHANNEL_ID = 'sulla-desktop';
const WORKBENCH_CHANNEL_ID = 'workbench';
const HEARTBEAT_CHANNEL_ID = 'heartbeat';
const CALENDAR_CHANNEL_ID = 'calendar_event';
// Dedicated channel for chats routed from a paired mobile device via the
// Cloudflare relay. Mobile messages arrive through `DesktopRelayClient`,
// which publishes them here as plain `user_message` frames. The agent
// loop picks them up the same way it picks up desktop UI messages —
// same AgentNode/BaseNode pipeline, same XML strip, same tool execution.
// Responses emitted by the agent land back on this channel; the relay
// client subscribes and forwards them up to Cloudflare → mobile.
const MOBILE_RELAY_CHANNEL_ID = 'mobile-relay';

let backendGraphWebSocketServiceInstance: BackendGraphWebSocketService | null = null;

export function getBackendGraphWebSocketService(): BackendGraphWebSocketService {
  if (!backendGraphWebSocketServiceInstance) {
    backendGraphWebSocketServiceInstance = new BackendGraphWebSocketService();
  }
  return backendGraphWebSocketServiceInstance;
}

export class BackendGraphWebSocketService {
  private readonly wsService = getWebSocketClientService();
  private readonly schedulerService = getSchedulerService();
  private unsubscribes: (() => void)[] = [];
  // Keyed by `${channelId}|${threadId}` so concurrent threads on the same
  // channel (e.g. multiple chat tabs sharing the workbench WebSocket) can
  // run in parallel. Previously this was keyed by channelId alone, which
  // made every new tab message abort the prior tab's still-running graph.
  private activeAborts = new Map<string, AbortService>();
  private subscribedChannels = new Set<string>();

  private abortKey(channelId: string, threadId: string): string {
    return `${ channelId }|${ threadId }`;
  }

  constructor() {
    this.initialize();
  }

  dispose(): void {
    this.unsubscribes.forEach(unsub => unsub());
    this.unsubscribes = [];
    for (const [, abort] of this.activeAborts) {
      abort.abort();
    }
    this.activeAborts.clear();
    this.subscribedChannels.clear();
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
      this.handleChannelMessage(SULLA_DESKTOP_CHANNEL_ID, 'sulla-desktop', msg);
    });
    if (sullaUnsub) this.unsubscribes.push(sullaUnsub);

    this.wsService.connect(WORKBENCH_CHANNEL_ID);
    const workbenchUnsub = this.wsService.onMessage(WORKBENCH_CHANNEL_ID, (msg) => {
      this.handleChannelMessage(WORKBENCH_CHANNEL_ID, 'workbench', msg);
    });
    if (workbenchUnsub) this.unsubscribes.push(workbenchUnsub);

    this.wsService.connect(HEARTBEAT_CHANNEL_ID);
    const heartbeatUnsub = this.wsService.onMessage(HEARTBEAT_CHANNEL_ID, (msg) => {
      this.handleChannelMessage(HEARTBEAT_CHANNEL_ID, 'heartbeat', msg);
    });
    if (heartbeatUnsub) this.unsubscribes.push(heartbeatUnsub);

    // Mobile relay channel — messages forwarded from a paired mobile device
    // via DesktopRelayClient. Agent processing is identical to the desktop
    // UI channel (same trigger type, same AgentNode pipeline) so the XML
    // wrappers, tool execution, memory recall, etc. all apply uniformly.
    this.wsService.connect(MOBILE_RELAY_CHANNEL_ID);
    const mobileRelayUnsub = this.wsService.onMessage(MOBILE_RELAY_CHANNEL_ID, (msg) => {
      this.handleChannelMessage(MOBILE_RELAY_CHANNEL_ID, 'sulla-desktop', msg);
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
    this.subscribedChannels.add(WORKBENCH_CHANNEL_ID);
    this.subscribedChannels.add(HEARTBEAT_CHANNEL_ID);
    this.subscribedChannels.add(MOBILE_RELAY_CHANNEL_ID);
    this.subscribedChannels.add(CALENDAR_CHANNEL_ID);

    // Register agents in the active agents registry
    this.registerAgent(SULLA_DESKTOP_CHANNEL_ID, 'Sulla', 'Frontend chat agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register sulla-desktop agent:', err));
    this.registerAgent(WORKBENCH_CHANNEL_ID, 'Workbench', 'Workbench editor agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register workbench agent:', err));
    this.registerAgent(HEARTBEAT_CHANNEL_ID, 'Heartbeat', 'Autonomous heartbeat agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register heartbeat agent:', err));
    this.registerAgent(MOBILE_RELAY_CHANNEL_ID, 'Sulla (Mobile)', 'Chat routed from paired mobile device').catch(err =>
      console.warn('[BackendGraphWS] Failed to register mobile-relay agent:', err));

    // Subscribe to any custom agent channels from ~/sulla/agents/
    this.subscribeToAgentChannels().catch(err =>
      console.warn('[BackendGraphWS] Failed to subscribe to agent channels:', err));
  }

  /**
   * Dynamically subscribe to a custom agent channel so it can receive messages.
   * Messages on custom agent channels are treated as 'sulla-desktop' trigger type.
   */
  subscribeToChannel(channelId: string): void {
    if (this.subscribedChannels.has(channelId)) return;
    this.wsService.connect(channelId);
    const unsub = this.wsService.onMessage(channelId, (msg) => {
      this.handleChannelMessage(channelId, 'sulla-desktop', msg);
    });
    if (unsub) this.unsubscribes.push(unsub);
    this.subscribedChannels.add(channelId);
  }

  /**
   * Scan ~/sulla/agents/ and subscribe to each agent's channel.
   */
  private async subscribeToAgentChannels(): Promise<void> {
    try {
      const { resolveAllAgentsDirs } = await import('../utils/sullaPaths');
      const fs = await import('fs');

      for (const agentsRoot of resolveAllAgentsDirs()) {
        if (!fs.existsSync(agentsRoot)) continue;

        const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
          this.subscribeToChannel(entry.name);
        }
      }
    } catch (err) {
      console.error('[BackendGraphWS] Error scanning agent channels:', err);
    }
  }

  // ------------------------------------------------------------------
  // Unified channel message handling — dispatches to default agent via GraphRegistry
  // ------------------------------------------------------------------

  private async handleChannelMessage(
    channelId: string,
    _triggerType: 'sulla-desktop' | 'workbench' | 'heartbeat',
    msg: WebSocketMessage,
  ): Promise<void> {
    const _msgData = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : { content: msg.data };
    const _rawContent = typeof _msgData?.content === 'string' ? _msgData.content : JSON.stringify(_msgData?.content ?? '');
    if (_triggerType !== 'heartbeat') {
      console.log(`[BackendGraphWS] ← message on "${ channelId }"`, {
        type:         msg.type,
        id:           msg.id,
        channel:      msg.channel,
        timestamp:    msg.timestamp,
        triggerType:  _triggerType,
        threadId:     _msgData?.threadId,
        metadata:     _msgData?.metadata,
        contentChars: _rawContent.length,
        content:      _rawContent.slice(0, 100),
      });
    }

    if (msg.type === 'stop_run') {
      // Stop a specific thread when the frontend supplies one (current chat
      // tab); otherwise stop every active run on the channel as a fallback
      // for older clients.
      const data = typeof msg.data === 'string' ? {} : (msg.data as any);
      const stopThreadId = typeof data?.threadId === 'string' ? data.threadId : '';
      if (stopThreadId) {
        this.activeAborts.get(this.abortKey(channelId, stopThreadId))?.abort();
      } else {
        const prefix = `${ channelId }|`;
        for (const [k, abort] of this.activeAborts) {
          if (k.startsWith(prefix)) abort.abort();
        }
      }
      return;
    }

    if (msg.type === 'new_conversation') {
      const data = typeof msg.data === 'string' ? {} : (msg.data as any);
      const threadId = data?.threadId as string | undefined;
      if (threadId) {
        GraphRegistry.delete(threadId);
      }
      return;
    }

    // ── Inject message into running graph state (no execution trigger) ──
    if (msg.type === 'inject_message') {
      const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data as any);
      const content = (data?.content ?? '').trim();
      const threadId = data?.threadId as string | undefined;
      if (!content || !threadId) return;

      const existing = GraphRegistry.get(threadId);
      if (existing) {
        // Graph state exists — inject directly without executing
        const attachments = data?.metadata?.attachments as any[] | undefined;
        const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
        const messageContent: any = hasAttachments
          ? [{ type: 'text', text: content }, ...attachments.filter((a: any) => a?.type === 'image' && a?.source?.type === 'base64')]
          : content;

        existing.state.messages.push({
          id:        nextMessageId(),
          role:      'user',
          content:   messageContent,
          timestamp: Date.now(),
          metadata:  { source: 'inject', inputSource: data?.metadata?.inputSource || 'keyboard' },
        } as any);
        console.log(`[BackendGraphWS] Injected message into running state for thread ${ threadId }: ${ content.slice(0, 50) }...`);
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

  private async dispatchToAgent(channelId: string, triggerType: string, message: string, threadIdFromMsg?: string, scopedWorkflowId?: string, overrideAgentId?: string, inputSource?: string, metadata?: Record<string, any>): Promise<void> {
    const agentId = overrideAgentId || await getAgentIdForTrigger(triggerType) || channelId;

    // Use the frontend's threadId if provided (maintains conversation).
    // Otherwise create a new one and notify the frontend via thread_created.
    const isNewThread = !threadIdFromMsg;
    const threadId = threadIdFromMsg || nextThreadId();

    let state: AgentGraphState | undefined;

    try {
      const result = await GraphRegistry.getOrCreateAgentGraph(agentId, threadId) as { graph: any; state: AgentGraphState };
      const graph = result.graph;
      state = result.state;

      // Notify frontend of the threadId so it can maintain the conversation
      if (isNewThread) {
        this.wsService.send(channelId, {
          type:      'thread_created',
          data:      { threadId },
          timestamp: Date.now(),
        });
      }

      // Abort any prior run still in flight FOR THIS SAME THREAD before
      // starting a new one. Per-thread (not per-channel) so multiple chat
      // tabs sharing the same WebSocket channel can run in parallel.
      // Rapid double-sends from the same tab still get coalesced because
      // they share a thread id.
      const abortKey = this.abortKey(channelId, threadId);
      const prior = this.activeAborts.get(abortKey);
      if (prior) {
        try { prior.abort(); } catch { /* already aborted */ }
        this.activeAborts.delete(abortKey);
      }

      // Create abort service for this run.
      // Set state first so stop_run can't race between activeAborts and state.
      const abort = new AbortService();
      state.metadata.options.abort = abort;
      this.activeAborts.set(abortKey, abort);

      // Route responses back to the originating channel
      state.metadata.wsChannel = channelId;

      // Scope workflow tools to a specific workflow (e.g. when chatting from workflow editor)
      if (scopedWorkflowId) {
        (state.metadata as any).scopedWorkflowId = scopedWorkflowId;
      }

      // Track input modality so downstream nodes can adapt (e.g. voice → TTS).
      // Reset each dispatch so keyboard messages don't inherit a prior voice flag.
      (state.metadata as any).inputSource = inputSource || 'keyboard';

      // Append user message — include image attachments as content blocks if present
      const attachments = metadata?.attachments as any[] | undefined;
      const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
      const messageContent: any = hasAttachments
        ? [
          { type: 'text', text: message },
          ...attachments.filter((a: any) => a?.type === 'image' && a?.source?.type === 'base64'),
        ]
        : message;

      state.messages.push({
        id:        nextMessageId(),
        role:      'user',
        content:   messageContent,
        timestamp: Date.now(),
        metadata:  { source: 'backend', inputSource: inputSource || 'keyboard' },
      } as any);

      // Resume from current node if the agent was waiting for user input
      const resumeNodeId = state.metadata.waitingForUser === true
        ? String(state.metadata.currentNodeId || '').trim()
        : '';
      const shouldResumeFromCurrentNode = !!resumeNodeId &&
        resumeNodeId !== 'input_handler' &&
        resumeNodeId !== 'output';

      // Reset execution counters for this run (but NOT messages — those accumulate)
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      (state.metadata as any).agentLoopCount = 0;
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;

      const startNode = shouldResumeFromCurrentNode ? resumeNodeId : 'input_handler';
      await graph.execute(state, startNode);
    } catch (err: any) {
      if (err?.name === 'AbortError' && state) {
        // Cleanly aborted by user — mark cycle complete so graph won't restart
        state.metadata.cycleComplete = true;
        state.metadata.waitingForUser = true;
      } else if (err?.name !== 'AbortError') {
        console.error(`[BackendGraphWS] Agent execution FAILED on ${ channelId }:`, err);
        this.emitMessage(channelId, 'assistant_message', {
          content:   `Agent error: ${ err.message || String(err) }`,
          role:      'assistant',
          thread_id: threadId,
        });
      }
    } finally {
      this.activeAborts.delete(this.abortKey(channelId, threadId));
    }
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

  // ------------------------------------------------------------------
  // Calendar handling (unchanged)
  // ------------------------------------------------------------------

  private async handleCalendarMessage(msg: WebSocketMessage): Promise<void> {
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
