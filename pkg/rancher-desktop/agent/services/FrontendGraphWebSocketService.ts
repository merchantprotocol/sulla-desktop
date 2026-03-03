import type { Ref } from 'vue';
import type { AgentGraphState } from '../nodes/Graph';
import { getWebSocketClientService, type WebSocketMessage } from './WebSocketClientService';
import { AbortService } from './AbortService';
import { GraphRegistry, nextThreadId, nextMessageId } from './GraphRegistry';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

const FRONTEND_CHANNEL_ID = 'chat-controller';

export type FrontendGraphWebSocketDeps = {
  currentThreadId: Ref<string | null>;
};

export class FrontendGraphWebSocketService {
  private readonly wsService = getWebSocketClientService();
  private unsubscribe: (() => void) | null = null;
  private activeAbort: AbortService | null = null;

  constructor(private readonly deps: FrontendGraphWebSocketDeps) {
    this.initialize();
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }

    // Frontend is only available while the app window is open.
    // Remove it from the active agents registry on teardown.
    this.deregisterAgent().catch(err => console.warn('[FrontendGraphWS] Failed to deregister agent:', err));
  }

  private initialize(): void {
    this.wsService.connect(FRONTEND_CHANNEL_ID);
    this.unsubscribe = this.wsService.onMessage(FRONTEND_CHANNEL_ID, (msg) => {
      this.handleWebSocketMessage(msg);
    });

    // Register frontend agent in the active agents registry
    this.registerAgent().catch(err => console.warn('[FrontendGraphWS] Failed to register agent:', err));
  }

  private async registerAgent(): Promise<void> {
    const { getActiveAgentsRegistry } = await import('./ActiveAgentsRegistry');
    const registry = getActiveAgentsRegistry();
    await registry.register({
      agentId: FRONTEND_CHANNEL_ID,
      name: 'Sulla',
      role: 'Frontend chat agent',
      channel: FRONTEND_CHANNEL_ID,
      type: 'frontend',
      status: 'running',
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      description: 'Frontend chat agent — handles direct human conversations',
    });
  }

  private async deregisterAgent(): Promise<void> {
    const { getActiveAgentsRegistry } = await import('./ActiveAgentsRegistry');
    const registry = getActiveAgentsRegistry();
    await registry.deregister(FRONTEND_CHANNEL_ID);
  }

  private async handleWebSocketMessage(msg: WebSocketMessage): Promise<void> {
    if (msg.type === 'stop_run') {
      console.log('[FrontendGraphWS] stop_run received');
      this.activeAbort?.abort();
      return;
    }

    if (msg.type === 'continue_run') {
      console.log('[FrontendGraphWS] continue_run received — resuming graph');
      await this.continueGraphExecution();
      return;
    }

    if (msg.type !== 'user_message') return;

    const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data as any);
    const content = (data?.content ?? '').trim();
    if (!content) return;

    const threadIdFromMsg = data?.threadId as string | undefined;

    // Scheduler ack
    const metadata = data?.metadata;
    if (metadata?.origin === 'scheduler' && typeof metadata?.eventId === 'number') {
      this.wsService.send(FRONTEND_CHANNEL_ID, {
        type: 'scheduler_ack',
        data: { eventId: metadata.eventId },
        timestamp: Date.now(),
      });
    }

    await this.processUserInput(content, threadIdFromMsg);
  }

  private async processUserInput(userText: string, threadIdFromMsg?: string): Promise<void> {
    const channelId = FRONTEND_CHANNEL_ID;
    const threadId = threadIdFromMsg || nextThreadId();
    
    // Get or create persistent AgentGraph for this thread - do this outside try/catch
    const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(channelId, threadId) as { graph: any; state: AgentGraphState };

    // Create a fresh AbortService for this run and wire it into state
    const abort = new AbortService();
    this.activeAbort = abort;
    state.metadata.options.abort = abort;

    // Always refresh model context from current settings so existing threads
    // follow the currently selected frontend model/provider.
    const mode = await SullaSettingsModel.get('modelMode', 'local');
    state.metadata.llmLocal = mode === 'local';
    state.metadata.llmModel = mode === 'remote'
      ? await SullaSettingsModel.get('remoteModel', '')
      : await SullaSettingsModel.get('sullaModel', '');

    try {

      // === NEW: Notify AgentPersonaService about the threadId ===
      if (!threadIdFromMsg) {
        this.wsService.send(channelId, {
          type: 'thread_created',
          data: {
            threadId: state.metadata.threadId
          },
          timestamp: Date.now()
        });
      }

      // Update local ref (for UI)
      if (!this.deps.currentThreadId.value) {
        this.deps.currentThreadId.value = threadId;
      }

      state.metadata.wsChannel = channelId;

      // Append new user message
      const newMsg = {
        id: nextMessageId(),
        role: 'user',
        content: userText,
        timestamp: Date.now(),
        metadata: { source: 'user' }
      };
      state.messages.push(newMsg as any);

      // Reset pause flags when real user input comes in
      const resumeNodeId = state.metadata.waitingForUser === true
        ? String(state.metadata.currentNodeId || '').trim()
        : '';
      const shouldResumeFromCurrentNode = !!resumeNodeId
        && resumeNodeId !== 'input_handler'
        && resumeNodeId !== 'output';

      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      state.metadata.agentLoopCount = 0;   
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;

      // Execute on the persistent AgentGraph starting from input_handler
      await graph.execute(state, shouldResumeFromCurrentNode ? resumeNodeId : 'input_handler');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[FrontendGraphWS] Execution aborted');
        this.emitSystemMessage('Execution stopped.');
      } else {
        console.error('[FrontendGraphWS] Error:', err);
        this.emitSystemMessage(`Error: ${err.message || String(err)}`);
      }
    } finally {
      // Reset here — after graph run completes this is fine
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      (state.metadata as any).agentLoopCount = 0;
      this.activeAbort = null;
    }
  }

  private async continueGraphExecution(): Promise<void> {
    const threadId = this.deps.currentThreadId.value;
    if (!threadId) {
      console.warn('[FrontendGraphWS] No thread to continue');
      return;
    }

    const existing = GraphRegistry.get(threadId);
    if (!existing) {
      console.warn('[FrontendGraphWS] No existing graph to continue');
      return;
    }

    const { graph, state } = existing as { graph: any; state: AgentGraphState };

    // Create a fresh AbortService for this run
    const abort = new AbortService();
    this.activeAbort = abort;
    state.metadata.options.abort = abort;

    try {
      // Reset loop counters so the graph can run another full set of cycles
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      (state.metadata as any).agentLoopCount = 0;
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;

      // Resume from the agent node directly
      await graph.execute(state, 'agent');
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('[FrontendGraphWS] Continue execution aborted');
        this.emitSystemMessage('Execution stopped.');
      } else {
        console.error('[FrontendGraphWS] Continue error:', err);
        this.emitSystemMessage(`Error: ${err.message || String(err)}`);
      }
    } finally {
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      (state.metadata as any).agentLoopCount = 0;
      this.activeAbort = null;
    }
  }

  private emitAssistantMessage(content: string): void {
    this.wsService.send(FRONTEND_CHANNEL_ID, {
      type: 'assistant_message',
      data: { role: 'assistant', content },
      timestamp: Date.now(),
    });
  }

  private emitSystemMessage(content: string): void {
    this.wsService.send(FRONTEND_CHANNEL_ID, {
      type: 'system_message',
      data: content,
      timestamp: Date.now(),
    });
  }
}