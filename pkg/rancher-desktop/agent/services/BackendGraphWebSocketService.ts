// BackendGraphWebSocketService.ts
// Main-process agent dispatcher: routes messages on the sulla-desktop, workbench,
// and heartbeat channels to the default agent via GraphRegistry.
import { getWebSocketClientService, type WebSocketMessage } from './WebSocketClientService';
import { getSchedulerService } from './SchedulerService';
import type { CalendarEventData } from './CalendarClient';
import { AbortService } from './AbortService';
import { GraphRegistry, getAgentIdForTrigger, nextThreadId, nextMessageId } from './GraphRegistry';
import type { AgentGraphState } from '../nodes/Graph';

const SULLA_DESKTOP_CHANNEL_ID = 'sulla-desktop';
const WORKBENCH_CHANNEL_ID = 'workbench';
const HEARTBEAT_CHANNEL_ID = 'heartbeat';
const CALENDAR_CHANNEL_ID = 'calendar_event';

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
  private activeAborts = new Map<string, AbortService>();
  private subscribedChannels = new Set<string>();

  constructor() {
    this.initialize();
  }

  dispose(): void {
    console.log('[BackendGraphWS] Disposing service, cleaning up', this.unsubscribes.length, 'subscriptions');
    this.unsubscribes.forEach(unsub => unsub());
    this.unsubscribes = [];
    for (const [, abort] of this.activeAborts) {
      abort.abort();
    }
    this.activeAborts.clear();
    console.log('[BackendGraphWS] Service disposed');
  }

  private initialize(): void {
    // Initialize sulla-desktop channel
    console.log('[BackendGraphWS] Initializing channel:', SULLA_DESKTOP_CHANNEL_ID);
    this.wsService.connect(SULLA_DESKTOP_CHANNEL_ID);
    const sullaUnsub = this.wsService.onMessage(SULLA_DESKTOP_CHANNEL_ID, (msg) => {
      this.handleChannelMessage(SULLA_DESKTOP_CHANNEL_ID, 'sulla-desktop', msg);
    });
    if (sullaUnsub) this.unsubscribes.push(sullaUnsub);

    // Initialize workbench channel
    console.log('[BackendGraphWS] Initializing channel:', WORKBENCH_CHANNEL_ID);
    this.wsService.connect(WORKBENCH_CHANNEL_ID);
    const workbenchUnsub = this.wsService.onMessage(WORKBENCH_CHANNEL_ID, (msg) => {
      this.handleChannelMessage(WORKBENCH_CHANNEL_ID, 'workbench', msg);
    });
    if (workbenchUnsub) this.unsubscribes.push(workbenchUnsub);

    // Initialize heartbeat channel
    console.log('[BackendGraphWS] Initializing channel:', HEARTBEAT_CHANNEL_ID);
    this.wsService.connect(HEARTBEAT_CHANNEL_ID);
    const heartbeatUnsub = this.wsService.onMessage(HEARTBEAT_CHANNEL_ID, (msg) => {
      this.handleChannelMessage(HEARTBEAT_CHANNEL_ID, 'heartbeat', msg);
    });
    if (heartbeatUnsub) this.unsubscribes.push(heartbeatUnsub);

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
    this.subscribedChannels.add(CALENDAR_CHANNEL_ID);

    // Register agents in the active agents registry
    this.registerAgent(SULLA_DESKTOP_CHANNEL_ID, 'Sulla', 'Frontend chat agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register sulla-desktop agent:', err));
    this.registerAgent(WORKBENCH_CHANNEL_ID, 'Workbench', 'Workbench editor agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register workbench agent:', err));
    this.registerAgent(HEARTBEAT_CHANNEL_ID, 'Heartbeat', 'Autonomous heartbeat agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register heartbeat agent:', err));

    // Subscribe to any custom agent channels from ~/sulla/agents/
    this.subscribeToAgentChannels().catch(err =>
      console.warn('[BackendGraphWS] Failed to subscribe to agent channels:', err));

    console.log('[Background] BackendGraphWebSocketService initialized');
  }

  /**
   * Dynamically subscribe to a custom agent channel so it can receive messages.
   * Messages on custom agent channels are treated as 'sulla-desktop' trigger type.
   */
  subscribeToChannel(channelId: string): void {
    if (this.subscribedChannels.has(channelId)) return;

    console.log(`[BackendGraphWS] Dynamically subscribing to channel: "${channelId}"`);
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
      const { resolveSullaAgentsDir } = await import('../utils/sullaPaths');
      const fs = await import('fs');
      const agentsRoot = resolveSullaAgentsDir();
      if (!fs.existsSync(agentsRoot)) return;

      const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        this.subscribeToChannel(entry.name);
      }
      console.log(`[BackendGraphWS] Subscribed to ${this.subscribedChannels.size} total channels`);
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
    if (msg.type === 'stop_run') {
      console.log(`[BackendGraphWS] stop_run on ${channelId}`);
      this.activeAborts.get(channelId)?.abort();
      return;
    }

    if (msg.type !== 'user_message') return;

    const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data as any);
    const content = (data?.content ?? '').trim();
    if (!content) return;

    console.log(`[BackendGraphWS] user_message on ${channelId} — content="${content.slice(0, 80)}"`);

    // Scheduler ack
    const metadata = data?.metadata;
    if (metadata?.origin === 'scheduler' && typeof metadata?.eventId === 'number') {
      this.wsService.send(channelId, {
        type: 'scheduler_ack',
        data: { eventId: metadata.eventId },
        timestamp: Date.now(),
      });
    }

    await this.dispatchToAgent(channelId, _triggerType, content);
  }

  private async dispatchToAgent(channelId: string, triggerType: string, message: string): Promise<void> {
    console.log(`[BackendGraphWS] dispatchToAgent() START — channelId="${channelId}", triggerType="${triggerType}", message="${message.slice(0, 80)}"`);

    const agentId = await getAgentIdForTrigger(triggerType);
    const threadId = nextThreadId();

    console.log(`[BackendGraphWS] dispatchToAgent() — resolved agentId="${agentId}", threadId="${threadId}"`);

    try {
      console.log(`[BackendGraphWS] dispatchToAgent() — calling GraphRegistry.getOrCreateAgentGraph...`);
      const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(agentId, threadId) as { graph: any; state: AgentGraphState };
      console.log(`[BackendGraphWS] dispatchToAgent() — graph ready, model="${state.metadata.llmModel}", local=${state.metadata.llmLocal}`);

      // Create abort service for this run
      const abort = new AbortService();
      this.activeAborts.set(channelId, abort);
      state.metadata.options.abort = abort;

      // Route responses back to the originating channel
      state.metadata.wsChannel = channelId;

      // Append user message
      state.messages.push({
        id:        nextMessageId(),
        role:      'user',
        content:   message,
        timestamp: Date.now(),
        metadata:  { source: 'backend' },
      } as any);

      // Reset state for fresh run
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      (state.metadata as any).agentLoopCount = 0;
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;

      console.log(`[BackendGraphWS] dispatchToAgent() — executing graph from 'input_handler'...`);
      const startMs = Date.now();
      await graph.execute(state, 'input_handler');
      console.log(`[BackendGraphWS] dispatchToAgent() — graph execution COMPLETED in ${Date.now() - startMs}ms`);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.log(`[BackendGraphWS] Execution aborted on ${channelId}`);
      } else {
        console.error(`[BackendGraphWS] Agent execution FAILED on ${channelId}:`, err);
        this.emitMessage(channelId, 'assistant_message', {
          content: `Agent error: ${err.message || String(err)}`,
          role: 'assistant',
        });
      }
    } finally {
      this.activeAborts.delete(channelId);
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
  type: 'scheduled' | 'cancel' | 'reschedule';
  event?: CalendarEventData;
  id: string;
  timestamp: number;
  channel: string;
}
