// BackendGraphWebSocketService.ts
// listens for messages from the frontend and processes them
import { getWebSocketClientService, type WebSocketMessage } from './WebSocketClientService';
import { getSchedulerService } from './SchedulerService';
import type { CalendarEventData } from './CalendarClient';
import { AbortService } from './AbortService';
import { GraphRegistry, nextThreadId, nextMessageId } from './GraphRegistry';
import type { HeartbeatThreadState } from '../nodes/HeartbeatNode';

const BACKEND_CHANNEL_ID = 'dreaming-protocol';
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
  private activeAbort: AbortService | null = null;

  constructor() {
    this.initialize();
  }

  dispose(): void {
    console.log('[BackendGraphWS] Disposing service, cleaning up', this.unsubscribes.length, 'subscriptions');
    this.unsubscribes.forEach(unsub => unsub());
    this.unsubscribes = [];
    if (this.activeAbort) {
      console.log('[BackendGraphWS] Aborting active execution during dispose');
      this.activeAbort.abort();
      this.activeAbort = null;
    }
    console.log('[BackendGraphWS] Service disposed');
  }

  private initialize(): void {
    // Initialize chat controller backend channel
    console.log('[BackendGraphWS] Initializing backend channel:', BACKEND_CHANNEL_ID);
    this.wsService.connect(BACKEND_CHANNEL_ID);
    console.log('[Background] BackendGraphWebSocketService initialized');

    // Register heartbeat agent in the active agents registry
    this.registerAgent().catch(err => console.warn('[BackendGraphWS] Failed to register agent:', err));

    const chatUnsubscribe = this.wsService.onMessage(BACKEND_CHANNEL_ID, (msg) => {
      console.log('[BackendGraphWS] Received message on backend channel:', msg.type, msg);
      this.handleWebSocketMessage(msg);
    });
    if (chatUnsubscribe) {
      this.unsubscribes.push(chatUnsubscribe);
      console.log('[BackendGraphWS] Chat channel subscription added');
    }

    // Initialize calendar event channel
    console.log('[BackendGraphWS] Initializing calendar channel:', CALENDAR_CHANNEL_ID);
    this.wsService.connect(CALENDAR_CHANNEL_ID);
    console.log('[Background] BackendGraphWebSocketService calendar channel initialized');

    const calendarUnsubscribe = this.wsService.onMessage(CALENDAR_CHANNEL_ID, (msg) => {
      console.log('[BackendGraphWS] Received calendar message:', msg.type, msg);
      this.handleCalendarMessage(msg);
    });
    if (calendarUnsubscribe) {
      this.unsubscribes.push(calendarUnsubscribe);
      console.log('[BackendGraphWS] Calendar channel subscription added successfully');
    } else {
      console.warn('[BackendGraphWS] Failed to add calendar channel subscription');
    }
  }

  private async handleWebSocketMessage(msg: WebSocketMessage): Promise<void> {
    console.log('[BackendGraphWS] Handling WebSocket message:', msg.type);

    if (msg.type === 'graph_runtime_update') {
      this.handleGraphRuntimeUpdate(msg);
      return;
    }
    
    if (msg.type === 'stop_run') {
      console.log('[BackendGraphWS] stop_run received, aborting active execution');
      this.activeAbort?.abort();
      return;
    }

    if (msg.type !== 'user_message') {
      console.log('[BackendGraphWS] Ignoring non-user message type:', msg.type);
      return;
    }

    const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data as any);
    const content = (data?.content ?? '').trim();
    console.log('[BackendGraphWS] Processing user message content:', content.substring(0, 100) + (content.length > 100 ? '...' : ''));
    
    if (!content) {
      console.log('[BackendGraphWS] Empty content, skipping message');
      return;
    }

    const threadIdFromMsg = data?.threadId as string | undefined;
    console.log('[BackendGraphWS] Thread ID from message:', threadIdFromMsg || 'none provided');

    // Scheduler ack
    const metadata = data?.metadata;
    if (metadata?.origin === 'scheduler' && typeof metadata?.eventId === 'number') {
      console.log('[BackendGraphWS] Sending scheduler ack for event:', metadata.eventId);
      this.wsService.send(BACKEND_CHANNEL_ID, {
        type: 'scheduler_ack',
        data: { eventId: metadata.eventId },
        timestamp: Date.now(),
      });
    }

    console.log('[BackendGraphWS] Starting user input processing');
    await this.processUserInput(content, threadIdFromMsg);
  }

  private handleGraphRuntimeUpdate(msg: WebSocketMessage): void {
    const data = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : null;
    const threadId = typeof data?.threadId === 'string' ? data.threadId.trim() : '';
    const n8nLiveEventsEnabled = typeof data?.n8nLiveEventsEnabled === 'boolean'
      ? data.n8nLiveEventsEnabled
      : null;

    if (!threadId || n8nLiveEventsEnabled === null) {
      return;
    }

    const updated = GraphRegistry.updateRuntimeFlags(threadId, { n8nLiveEventsEnabled });
    const updatedByStateThreadId = GraphRegistry.updateRuntimeFlagsByStateThreadId(threadId, { n8nLiveEventsEnabled });
    if (!updated && updatedByStateThreadId === 0) {
      console.log('[BackendGraphWS] graph_runtime_update ignored (thread not found):', threadId);
      return;
    }

    console.log('[BackendGraphWS] graph_runtime_update applied:', {
      threadId,
      n8nLiveEventsEnabled,
      updatedByRegistryKey: updated,
      updatedByStateThreadId,
    });
  }

  private async processUserInput(userText: string, threadIdFromMsg?: string): Promise<void> {
    // Get or create persistent graph for this thread - do this outside try/catch
    console.log('[BackendGraphWS] Graph retrieved/created for channelId:', BACKEND_CHANNEL_ID);

    const { graph, state } = await GraphRegistry.getOrCreateOverlordGraph(
      BACKEND_CHANNEL_ID
    ) as { graph: any; state: HeartbeatThreadState };

    // Create a fresh AbortService for this run and wire it into state
    const abort = new AbortService();
    this.activeAbort = abort;
    state.metadata.options.abort = abort;

    try {

      // === NEW: Notify AgentPersonaService about the threadId ===
      if (!threadIdFromMsg) {
        console.log('[BackendGraphWS] New thread created, notifying frontend:', state.metadata.threadId);
        this.wsService.send(BACKEND_CHANNEL_ID, {
          type: 'thread_created',
          data: {
            threadId: state.metadata.threadId
          },
          timestamp: Date.now()
        });
      } else {
        console.log('[BackendGraphWS] Using existing thread:', threadIdFromMsg);
      }

      // Append new user message
      const newMsg = {
        id: nextMessageId(),
        role: 'user',
        content: userText,
        timestamp: Date.now(),
        metadata: { source: 'user' }
      };
      state.messages.push(newMsg as any);
      console.log('[BackendGraphWS] Added user message to state, total messages:', state.messages.length);

      // Reset pause flags when real user input comes in
      const resumeNodeId = state.metadata.waitingForUser === true
        ? String(state.metadata.currentNodeId || '').trim()
        : '';
      const shouldResumeFromCurrentNode = !!resumeNodeId && resumeNodeId !== 'input_handler';

      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;
      console.log('[BackendGraphWS] Reset pause flags, starting graph execution');

      // Execute on the persistent graph
      await graph.execute(state, shouldResumeFromCurrentNode ? resumeNodeId : 'input_handler');
      console.log('[BackendGraphWS] Graph execution completed');

      // Build response from final state
      const summaryContent = state.metadata.finalSummary?.trim() || (state.metadata as any).response?.trim() || '';
      const lastAssistantMessage = [...state.messages]
        .reverse()
        .find(msg => msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.trim());
      const content = summaryContent || (lastAssistantMessage?.content?.trim() || '');
      console.log('[BackendGraphWS] Generated response content length:', content.length);

      if (content) {
        console.log('[BackendGraphWS] Emitting assistant message');
        this.emitAssistantMessage(content);
      } else {
        console.log('[BackendGraphWS] No assistant content to emit');
      }

    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[BackendGraphWS] Execution aborted');
        this.emitSystemMessage('Execution stopped.');
      } else {
        console.error('[BackendGraphWS] Error:', err);
        this.emitSystemMessage(`Error: ${err.message || String(err)}`);
      }
    } finally {
      // Reset here — after graph run completes
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      (state.metadata as any).agentLoopCount = 0;
      this.activeAbort = null;
    }
  }

  private emitAssistantMessage(content: string): void {
    console.log('[BackendGraphWS] Emitting assistant message, content length:', content.length);
    this.wsService.send(BACKEND_CHANNEL_ID, {
      type: 'assistant_message',
      data: { role: 'assistant', content },
      timestamp: Date.now(),
    });
  }

  private emitSystemMessage(content: string): void {
    console.log('[BackendGraphWS] Emitting system message:', content);
    this.wsService.send(BACKEND_CHANNEL_ID, {
      type: 'system_message',
      data: content,
      timestamp: Date.now(),
    });
  }

  private async registerAgent(): Promise<void> {
    const { getActiveAgentsRegistry } = await import('./ActiveAgentsRegistry');
    const registry = getActiveAgentsRegistry();
    await registry.register({
      agentId: 'heartbeat',
      name: 'Radius',
      role: 'Autonomous heartbeat agent',
      channel: BACKEND_CHANNEL_ID,
      type: 'heartbeat',
      status: 'running',
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      description: 'Autonomous heartbeat agent — runs background tasks and projects',
    });
  }

  private async handleCalendarMessage(msg: WebSocketMessage): Promise<void> {
    console.log('[BackendGraphWS] handleCalendarMessage called with:', msg);
    
    // The calendar message data is directly on the message object, not in msg.data
    const calendarMsg = msg as CalendarWebSocketMessage;

    if (!calendarMsg || typeof calendarMsg.type !== 'string') {
      console.warn('[BackendGraphWS] Invalid calendar message format:', calendarMsg);
      return;
    }

    const { type, event } = calendarMsg;
    console.log('[BackendGraphWS] Processing calendar message type:', type, 'event:', event);

    if (type === 'scheduled' && event) {
      try {
        console.log('[BackendGraphWS] Scheduling calendar event:', event);
        this.schedulerService.scheduleEvent(event);
        console.log('[BackendGraphWS] Calendar event scheduled successfully');
      } catch (err) {
        console.error('[BackendGraphWS] Failed to schedule calendar event:', err);
      }
    } else if (type === 'cancel' && event?.id) {
      try {
        console.log('[BackendGraphWS] Canceling calendar event:', event.id);
        this.schedulerService.cancelEvent(event.id);
        console.log('[BackendGraphWS] Calendar event canceled successfully');
      } catch (err) {
        console.error('[BackendGraphWS] Failed to cancel calendar event:', err);
      }
    } else if (type === 'reschedule' && event) {
      try {
        console.log('[BackendGraphWS] Rescheduling calendar event:', event);
        this.schedulerService.rescheduleEvent(event);
        console.log('[BackendGraphWS] Calendar event rescheduled successfully');
      } catch (err) {
        console.error('[BackendGraphWS] Failed to reschedule calendar event:', err);
      }
    } else {
      console.log('[BackendGraphWS] Unknown calendar message type:', type);
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
