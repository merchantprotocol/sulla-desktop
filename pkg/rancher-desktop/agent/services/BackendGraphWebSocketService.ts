// BackendGraphWebSocketService.ts
// Main-process workflow dispatcher: routes messages on the sulla-desktop and
// heartbeat channels to the WorkflowRegistry. No direct GraphRegistry usage —
// all agent execution is handled by workflow node handlers.
import { getWebSocketClientService, type WebSocketMessage } from './WebSocketClientService';
import { getSchedulerService } from './SchedulerService';
import type { CalendarEventData } from './CalendarClient';
import { AbortService } from './AbortService';

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

    // Register agents in the active agents registry
    this.registerAgent(SULLA_DESKTOP_CHANNEL_ID, 'Sulla', 'Frontend chat agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register sulla-desktop agent:', err));
    this.registerAgent(WORKBENCH_CHANNEL_ID, 'Workbench', 'Workbench editor agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register workbench agent:', err));
    this.registerAgent(HEARTBEAT_CHANNEL_ID, 'Heartbeat', 'Autonomous heartbeat agent').catch(err =>
      console.warn('[BackendGraphWS] Failed to register heartbeat agent:', err));

    console.log('[Background] BackendGraphWebSocketService initialized');
  }

  // ------------------------------------------------------------------
  // Unified channel message handling — dispatches to WorkflowRegistry
  // ------------------------------------------------------------------

  private async handleChannelMessage(
    channelId: string,
    triggerType: 'sulla-desktop' | 'workbench' | 'heartbeat',
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

    console.log(`[BackendGraphWS] user_message on ${channelId} — triggerType="${triggerType}", content="${content.slice(0, 80)}"`);

    // Scheduler ack
    const metadata = data?.metadata;
    if (metadata?.origin === 'scheduler' && typeof metadata?.eventId === 'number') {
      this.wsService.send(channelId, {
        type: 'scheduler_ack',
        data: { eventId: metadata.eventId },
        timestamp: Date.now(),
      });
    }

    await this.dispatchToWorkflow(channelId, triggerType, content);
  }

  private async dispatchToWorkflow(
    channelId: string,
    triggerType: 'sulla-desktop' | 'workbench' | 'heartbeat',
    message: string,
  ): Promise<void> {
    try {
      const { getWorkflowRegistry } = await import('../workflow/WorkflowRegistry');
      const registry = getWorkflowRegistry();

      console.log(`[BackendGraphWS] Dispatching to WorkflowRegistry — triggerType="${triggerType}", originChannel="${channelId}"`);

      const result = await registry.dispatch({
        triggerType,
        message,
        originChannel: channelId,
      });

      if (result) {
        console.log(`[BackendGraphWS] Workflow dispatched: "${result.workflowName}" (${result.workflowId}), executionId=${result.executionId}`);
      } else {
        console.log(`[BackendGraphWS] No workflow matched for triggerType="${triggerType}" — no action taken`);
        this.emitMessage(channelId, 'system_message', `No workflow configured for trigger type "${triggerType}". Create and enable a workflow with a "${triggerType}" trigger node.`);
      }
    } catch (err: any) {
      console.error(`[BackendGraphWS] Workflow dispatch failed on ${channelId}:`, err);
      this.emitMessage(channelId, 'system_message', `Error: ${err.message || String(err)}`);
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
