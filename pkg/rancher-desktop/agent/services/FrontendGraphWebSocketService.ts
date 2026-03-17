import type { Ref } from 'vue';
import type { AgentGraphState } from '../nodes/Graph';
import { getWebSocketClientService, type WebSocketMessage } from './WebSocketClientService';
import { AbortService } from './AbortService';
import { GraphRegistry, getAgentIdForTrigger, nextThreadId, nextMessageId } from './GraphRegistry';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { saveThreadState } from '../nodes/ThreadStateStore';

const DEFAULT_CHANNEL_ID = 'sulla-desktop';

export interface FrontendGraphWebSocketDeps {
  currentThreadId: Ref<string | null>;
}

export class FrontendGraphWebSocketService {
  private readonly wsService = getWebSocketClientService();
  private channelId:   string;
  private unsubscribe: (() => void) | null = null;
  private activeAbort: AbortService | null = null;

  constructor(private readonly deps: FrontendGraphWebSocketDeps, channelId?: string) {
    this.channelId = channelId || DEFAULT_CHANNEL_ID;
    this.initialize();
  }

  /**
   * Switch to a different agent channel. Tears down the old subscription
   * and re-initializes on the new channel.
   */
  async switchChannel(newChannelId: string): Promise<void> {
    if (newChannelId === this.channelId) return;

    // Tear down old channel
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }
    await this.deregisterAgent().catch(() => {});

    // Switch and re-initialize
    this.channelId = newChannelId;
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
    this.wsService.connect(this.channelId);
    this.unsubscribe = this.wsService.onMessage(this.channelId, (msg) => {
      this.handleWebSocketMessage(msg);
    });

    // Register frontend agent in the active agents registry
    this.registerAgent().catch(err => console.warn('[FrontendGraphWS] Failed to register agent:', err));
  }

  private async registerAgent(): Promise<void> {
    const { getActiveAgentsRegistry } = await import('./ActiveAgentsRegistry');
    const registry = getActiveAgentsRegistry();
    await registry.register({
      agentId:      this.channelId,
      name:         this.channelId === DEFAULT_CHANNEL_ID ? 'Sulla' : `Sulla (${ this.channelId })`,
      role:         'Frontend chat agent',
      channel:      this.channelId,
      type:         'frontend',
      status:       'running',
      startedAt:    Date.now(),
      lastActiveAt: Date.now(),
      description:  `Frontend chat agent on channel ${ this.channelId }`,
    });
  }

  private async deregisterAgent(): Promise<void> {
    const { getActiveAgentsRegistry } = await import('./ActiveAgentsRegistry');
    const registry = getActiveAgentsRegistry();
    await registry.deregister(this.channelId);
  }

  private async handleWebSocketMessage(msg: WebSocketMessage): Promise<void> {
    const _msgData = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : { content: msg.data };
    const _rawContent = typeof _msgData?.content === 'string' ? _msgData.content : JSON.stringify(_msgData?.content ?? '');
    console.log(`[FrontendGraphWS] ← message on "${ this.channelId }"`, {
      type:         msg.type,
      id:           msg.id,
      channel:      msg.channel,
      timestamp:    msg.timestamp,
      threadId:     _msgData?.threadId,
      metadata:     _msgData?.metadata,
      contentChars: _rawContent.length,
      content:      _rawContent.slice(0, 100),
    });

    if (msg.type === 'stop_run') {
      this.activeAbort?.abort();
      return;
    }

    if (msg.type === 'continue_run') {
      await this.continueGraphExecution();
      return;
    }

    if (msg.type !== 'user_message') return;

    const data = typeof msg.data === 'string' ? { content: msg.data } : (msg.data as any);
    const content = (data?.content ?? '').trim();
    if (!content) return;

    const threadIdFromMsg = data?.threadId as string | undefined;
    const metadata = data?.metadata;

    // Scheduler ack
    if (metadata?.origin === 'scheduler' && typeof metadata?.eventId === 'number') {
      this.wsService.send(this.channelId, {
        type:      'scheduler_ack',
        data:      { eventId: metadata.eventId },
        timestamp: Date.now(),
      });
    }

    await this.processUserInput(content, threadIdFromMsg);
  }

  private async processUserInput(userText: string, threadIdFromMsg?: string): Promise<void> {
    const channelId = this.channelId;

    // ThreadId is owned by the frontend chat interface.
    // Use the one from the message if provided, otherwise create a new one.
    const isNewThread = !threadIdFromMsg;
    const threadId = threadIdFromMsg || nextThreadId();
    const agentId = await getAgentIdForTrigger(channelId);

    // Get or create persistent AgentGraph for this thread using the default agent
    const { graph, state } = await GraphRegistry.getOrCreateAgentGraph(agentId, threadId) as { graph: any; state: AgentGraphState };

    // If this thread was restored from persistence and has prior messages,
    // emit them back to the frontend so the UI can hydrate the chat history.
    const priorMessageCount = state.messages.length;
    if (!isNewThread && priorMessageCount > 0) {
      this.wsService.send(channelId, {
        type:      'thread_restored',
        data:      {
          threadId,
          messages: state.messages,
        },
        timestamp: Date.now(),
      });
    }

    // Create a fresh AbortService for this run and wire it into state.
    // Set state first so stop_run can't race between activeAbort and state.
    const abort = new AbortService();
    state.metadata.options.abort = abort;
    this.activeAbort = abort;

    // Always refresh model context from current settings so existing threads
    // follow the currently selected frontend model/provider.
    const mode = await SullaSettingsModel.get('modelMode', 'local');
    state.metadata.llmLocal = mode === 'local';
    state.metadata.llmModel = mode === 'remote'
      ? await SullaSettingsModel.get('remoteModel', '')
      : await SullaSettingsModel.get('sullaModel', '');

    try {
      // Notify AgentPersonaService about the threadId so it stores it
      if (isNewThread) {
        this.wsService.send(channelId, {
          type: 'thread_created',
          data: {
            threadId: state.metadata.threadId,
          },
          timestamp: Date.now(),
        });
      }

      // Update local ref (for UI)
      if (!this.deps.currentThreadId.value) {
        this.deps.currentThreadId.value = threadId;
      }

      state.metadata.wsChannel = channelId;

      // Append new user message
      const newMsg = {
        id:        nextMessageId(),
        role:      'user',
        content:   userText,
        timestamp: Date.now(),
        metadata:  { source: 'user' },
      };
      state.messages.push(newMsg as any);

      // Reset pause flags when real user input comes in
      const resumeNodeId = state.metadata.waitingForUser === true
        ? String(state.metadata.currentNodeId || '').trim()
        : '';
      const shouldResumeFromCurrentNode = !!resumeNodeId &&
        resumeNodeId !== 'input_handler' &&
        resumeNodeId !== 'output';

      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      state.metadata.agentLoopCount = 0;
      state.metadata.cycleComplete = false;
      state.metadata.waitingForUser = false;

      // Execute on the persistent AgentGraph starting from input_handler
      const startNode = shouldResumeFromCurrentNode ? resumeNodeId : 'input_handler';
      await graph.execute(state, startNode);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        state.metadata.cycleComplete = true;
        state.metadata.waitingForUser = true;
        this.emitSystemMessage('Execution stopped.', threadId);
      } else {
        console.error('[FrontendGraphWS] Error:', err?.message);
        this.emitSystemMessage(`Error: ${ err.message || String(err) }`, threadId);
      }
    } finally {
      // Reset here — after graph run completes this is fine
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      (state.metadata as any).agentLoopCount = 0;
      this.activeAbort = null;

      // Persist thread state so it survives page reloads
      saveThreadState(state).catch(err => console.warn('[FrontendGraphWS] Failed to save thread state:', err));
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

    // Create a fresh AbortService for this run.
    // Set state first so stop_run can't race between activeAbort and state.
    const abort = new AbortService();
    state.metadata.options.abort = abort;
    this.activeAbort = abort;

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
        state.metadata.cycleComplete = true;
        state.metadata.waitingForUser = true;
        this.emitSystemMessage('Execution stopped.', threadId ?? undefined);
      } else {
        console.error('[FrontendGraphWS] Continue error:', err?.message);
        this.emitSystemMessage(`Error: ${ err.message || String(err) }`, threadId ?? undefined);
      }
    } finally {
      state.metadata.consecutiveSameNode = 0;
      state.metadata.iterations = 0;
      (state.metadata as any).agentLoopCount = 0;
      this.activeAbort = null;

      // Persist thread state so it survives page reloads
      saveThreadState(state).catch(err => console.warn('[FrontendGraphWS] Failed to save thread state:', err));
    }
  }

  private emitAssistantMessage(content: string, threadId?: string): void {
    this.wsService.send(this.channelId, {
      type:      'assistant_message',
      data:      { role: 'assistant', content, thread_id: threadId ?? this.deps.currentThreadId.value },
      timestamp: Date.now(),
    });
  }

  private emitSystemMessage(content: string, threadId?: string): void {
    this.wsService.send(this.channelId, {
      type:      'system_message',
      data:      { role: 'system', content, thread_id: threadId ?? this.deps.currentThreadId.value },
      timestamp: Date.now(),
    });
  }
}
