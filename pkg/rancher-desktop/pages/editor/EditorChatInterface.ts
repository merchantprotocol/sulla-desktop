// EditorChatInterface.ts — Chat controller for the workbench page.
// Routes all messages through the 'workbench' channel so they hit
// the agent assigned to the workbench trigger.
import { ref, watch, computed } from 'vue';
import { AgentPersonaRegistry, type ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { AgentPersonaService } from '@pkg/agent';
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';
import { ChatMessageQueue, createMessageQueue, type QueuedMessage } from '../agent/ChatMessageQueue';

const WORKBENCH_CHANNEL = 'workbench';
const MAX_PERSISTED_MESSAGES = 200;

/**
 * Handler signature for workflow execution events forwarded to the canvas.
 *
 * Registered via {@link EditorChatInterface.onWorkflowEvent} and invoked by the
 * WebSocket listener in the EditorChatInterface constructor whenever a
 * `workflow_execution_event` message arrives on the `workbench` channel.
 *
 * The consumer is `AgentEditor.vue`, which dispatches each event type to the
 * corresponding `WorkflowEditor.vue` method (see that component's doc blocks
 * for per-method details).
 *
 * **Important:** This is the canvas-only path. The chat message list receives
 * the same raw WebSocket event independently via `AgentPersonaModel.handleWebSocketMessage()`.
 */
export type WorkflowExecutionEventHandler = (event: {
  type:       string;
  nodeId?:    string;
  nodeLabel?: string;
  output?:    unknown;
  error?:     string;
  threadId?:  string;
  sourceId?:  string;
  targetId?:  string;
  /** Present on node_thinking events */
  content?:   string;
  role?:      'assistant' | 'system';
  kind?:      string;
  timestamp:  string;
}) => void;

export class EditorChatInterface {
  private readonly registry: AgentPersonaRegistry;
  private readonly persona:  AgentPersonaService;
  private readonly messageQueue: ChatMessageQueue;
  private readonly messagesStorageKey: string;

  readonly query = ref('');
  readonly messages = ref<ChatMessage[]>([]);

  /** When set, the agent will only see this workflow in list/execute tools */
  readonly activeWorkflowId = ref<string | null>(null);

  /** When set, overrides which agent handles messages on the backend */
  readonly activeAgentId = ref<string | null>(null);

  private watcher:              ReturnType<typeof watch> | null = null;
  private wsUnsub:              (() => void) | null = null;
  private workflowEventHandler: WorkflowExecutionEventHandler | null = null;

  readonly graphRunning = computed(() => {
    return this.persona.graphRunning.value;
  });

  readonly waitingForUser = computed(() => {
    return this.persona.waitingForUser.value;
  });

  readonly loading = ref(false);

  readonly currentActivity = computed(() => {
    return this.persona.currentActivity.value;
  });

  constructor() {
    // Create a minimal registry just for the persona service's internal needs
    this.registry = new AgentPersonaRegistry();
    this.persona = this.registry.getOrCreatePersonaService(WORKBENCH_CHANNEL);

    // Initialize message queue
    this.messageQueue = createMessageQueue();

    // Set up storage key for persistence
    this.messagesStorageKey = `chat_messages_${ WORKBENCH_CHANNEL }`;

    // Restore threadId and messages from localStorage
    this.persona.restoreThreadId();
    if (!this.persona.getThreadId()) {
      this.persona.setThreadId(`thread_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`);
    }
    this.restoreMessages();

    // Watch the persona's messages and mirror into our ref.
    // We watch the full array (deep) so sub-agent activity updates
    // (thinkingLines.push, status change) also trigger a UI refresh,
    // not only new message additions.
    this.watcher = watch(
      () => this.persona.messages,
      () => {
        this.updateMessages();
        this.persistMessages();
      },
      { deep: true },
    );

    this.updateMessages();

    // Watch graphRunning to process next queued message when current one completes
    watch(() => this.persona.graphRunning.value, (isRunning) => {
      if (!isRunning && this.messageQueue.hasPendingMessages.value) {
        console.log('[EditorChatInterface] Graph finished, processing next queued message');
        this.processNextQueuedMessage();
      }
    });

    // ── Canvas-path WebSocket listener ──────────────────────────────────
    // Subscribes to the `workbench` channel and forwards `workflow_execution_event`
    // messages to the handler registered via `onWorkflowEvent()`.
    //
    // This is one of TWO independent consumers of the same event:
    //   1. This listener → AgentEditor.vue → WorkflowEditor.vue (canvas updates)
    //   2. AgentPersonaModel.handleWebSocketMessage() (chat card updates)
    //
    // Both paths listen on the same WebSocket channel. Changes to the event
    // payload shape in Graph.emitPlaybookEvent() must be reflected in both.
    const ws = getWebSocketClientService();
    this.wsUnsub = ws.onMessage(WORKBENCH_CHANNEL, (msg) => {
      const _d = (msg.data && typeof msg.data === 'object') ? (msg.data as any) : { content: msg.data };
      const _raw = typeof _d?.content === 'string' ? _d.content : JSON.stringify(_d?.content ?? '');
      console.log(`[EditorChatInterface] ← message on "${ WORKBENCH_CHANNEL }"`, {
        type:         msg.type,
        id:           msg.id,
        channel:      msg.channel,
        timestamp:    msg.timestamp,
        threadId:     _d?.threadId,
        metadata:     _d?.metadata,
        contentChars: _raw.length,
        content:      _raw.slice(0, 100),
      });

      if (msg.type === 'workflow_execution_event' && this.workflowEventHandler) {
        const data = msg.data as any;
        this.workflowEventHandler(data);
      }
    });
  }

  /**
   * Register a handler for workflow execution events forwarded to the canvas.
   *
   * Only one handler is supported at a time (last-write-wins). The handler is
   * called for every `workflow_execution_event` message on the `workbench`
   * WebSocket channel with the raw `msg.data` payload from
   * {@link Graph.emitPlaybookEvent}.
   *
   * The sole consumer today is `AgentEditor.vue`, which dispatches to
   * `WorkflowEditor.vue` methods: `clearAllExecution`, `updateNodeExecution`,
   * `setEdgeAnimated`, and `pushNodeThinking`.
   */
  onWorkflowEvent(handler: WorkflowExecutionEventHandler): void {
    this.workflowEventHandler = handler;
  }

  private persistMessages(): void {
    try {
      // Strip image dataUrls and truncate large HTML to avoid blowing localStorage limits
      const toStore = this.persona.messages.slice(-MAX_PERSISTED_MESSAGES).map((m) => {
        if (m.image) {
          return { ...m, image: { ...m.image, dataUrl: '' } };
        }
        if (m.kind === 'html' && m.content.length > 50_000) {
          return { ...m, content: '[HTML content too large to persist]' };
        }
        return m;
      });
      localStorage.setItem(this.messagesStorageKey, JSON.stringify(toStore));
    } catch { /* storage full — silently degrade */ }
  }

  private restoreMessages(): void {
    try {
      const raw = localStorage.getItem(this.messagesStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ChatMessage[];
      if (Array.isArray(parsed) && parsed.length > 0 && this.persona.messages.length === 0) {
        // Mark any stale running tool cards as failed
        for (const m of parsed) {
          if (m.toolCard && m.toolCard.status === 'running') {
            m.toolCard.status = 'failed';
            m.toolCard.error = 'Interrupted by page reload';
          }
        }
        this.persona.messages.push(...parsed);
        console.log(`[EditorChatInterface] Restored ${ parsed.length } messages from localStorage`);
      }
    } catch { /* corrupt data — start fresh */ }
  }

  private updateMessages(): void {
    const msgs = [...this.persona.messages];
    const subAgentMsgs = msgs.filter(m => m.kind === 'sub_agent_activity');
    if (subAgentMsgs.length > 0) {
      console.log(`[EditorChatInterface] updateMessages() — total=${ msgs.length }, sub_agent_activity=${ subAgentMsgs.length }`, subAgentMsgs.map(m => ({
        nodeId: m.subAgentActivity?.nodeId,
        status: m.subAgentActivity?.status,
        lines:  m.subAgentActivity?.thinkingLines?.length,
      })));
    }
    // Filter out empty messages that have no specialized renderer (workflow_node,
    // tool, sub_agent_activity, etc.) — these would render as blank assistant bubbles.
    const filtered = msgs.filter(m => {
      // Always keep messages with a specialized kind that has its own renderer
      if (m.kind === 'workflow_node' || m.kind === 'tool' || m.kind === 'sub_agent_activity' ||
          m.kind === 'thinking' || m.kind === 'html') {
        return true;
      }
      // Always keep messages with image data
      if (m.image) return true;
      // Drop assistant/system messages with empty content
      if (m.role !== 'user' && (!m.content || !m.content.trim())) {
        console.warn(`⚠️ [EditorChatInterface] EMPTY ${ m.role } message filtered at UI layer — should have been caught earlier`, {
          id: m.id, role: m.role, kind: m.kind, channelId: m.channelId,
          threadId: m.threadId, contentLength: m.content?.length ?? 0,
          contentPreview: JSON.stringify(m.content)?.substring(0, 200),
          fullMessage: JSON.stringify(m).substring(0, 1000),
        });

        return false;
      }
      return true;
    });
    this.messages.value = filtered;
  }

  /**
   * Send a message. If the graph is currently running, the message will be
   * queued and sent automatically when the current processing completes.
   */
  async send(): Promise<void> {
    const text = this.query.value.trim();
    if (!text) return;

    // If graph is running, queue the message
    if (this.persona.graphRunning.value) {
      console.log(`[EditorChatInterface:send] Graph running, queuing message: ${ text.slice(0, 50) }...`);
      this.messageQueue.enqueue(text, [], {
        workflowId: this.activeWorkflowId.value || undefined,
        agentId:    this.activeAgentId.value || undefined,
      });
      this.query.value = '';
      return;
    }

    // Send immediately
    await this.sendMessageInternal(text);
  }

  /**
   * Internal method to send a message immediately
   */
  private async sendMessageInternal(text: string): Promise<void> {
    this.query.value = '';
    await this.persona.addUserMessage('', text, {
      workflowId: this.activeWorkflowId.value || undefined,
      agentId:    this.activeAgentId.value || undefined,
    });
  }

  /**
   * Process the next queued message when graph finishes
   */
  private async processNextQueuedMessage(): Promise<void> {
    const nextMessage = this.messageQueue.shift();
    if (!nextMessage) return;

    console.log(`[EditorChatInterface:processNextQueuedMessage] Sending queued message: ${ nextMessage.content.slice(0, 50) }...`);

    await this.sendMessageInternal(nextMessage.content);
  }

  /** Clear all messages and reset the thread so the next send starts a fresh conversation. */
  resetConversation(): void {
    // Capture threadId before clearing so the backend can delete the right graph
    const oldThreadId = this.persona.getThreadId();

    this.messages.value = [];
    this.persona.messages.splice(0);
    this.persona.clearThreadId();
    // Clear message queue
    this.messageQueue.clear();
    // Clear persisted messages
    try {
      localStorage.removeItem(this.messagesStorageKey);
    } catch { /* ignore */ }

    // Tell the backend to discard the old thread
    if (oldThreadId) {
      const ws = getWebSocketClientService();
      ws.send(WORKBENCH_CHANNEL, {
        type:      'new_conversation',
        data:      { threadId: oldThreadId },
        timestamp: Date.now(),
      });
    }
  }

  stop(): void {
    this.persona.emitStopSignal(WORKBENCH_CHANNEL);
    this.persona.graphRunning.value = false;
    // Clear the queue when stopping
    this.messageQueue.clear();
  }

  // ─── Queue Management ───────────────────────────────────────────

  /** Get the message queue for UI display */
  getQueue(): ChatMessageQueue {
    return this.messageQueue;
  }

  /** Remove a specific message from the queue */
  removeQueuedMessage(messageId: string): boolean {
    return this.messageQueue.dequeue(messageId);
  }

  /** Clear all pending messages */
  clearQueue(): void {
    this.messageQueue.clear();
  }

  /** Move a queued message up in priority */
  moveQueuedMessageUp(messageId: string): boolean {
    return this.messageQueue.moveUp(messageId);
  }

  /** Move a queued message down in priority */
  moveQueuedMessageDown(messageId: string): boolean {
    return this.messageQueue.moveDown(messageId);
  }

  dispose(): void {
    this.persona.stopListening();
    if (this.watcher) {
      this.watcher();
      this.watcher = null;
    }
    if (this.wsUnsub) {
      this.wsUnsub();
      this.wsUnsub = null;
    }
    this.workflowEventHandler = null;
  }
}
