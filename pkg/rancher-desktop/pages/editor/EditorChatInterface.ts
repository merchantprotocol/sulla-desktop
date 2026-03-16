// EditorChatInterface.ts — Chat controller for the workbench page.
// Routes all messages through the 'workbench' channel so they hit
// the agent assigned to the workbench trigger.
import { ref, watch, computed } from 'vue';
import { AgentPersonaRegistry, type ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { AgentPersonaService } from '@pkg/agent';
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';

const WORKBENCH_CHANNEL = 'workbench';

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

    // Watch the persona's messages and mirror into our ref.
    // We watch the full array (deep) so sub-agent activity updates
    // (thinkingLines.push, status change) also trigger a UI refresh,
    // not only new message additions.
    this.watcher = watch(
      () => this.persona.messages,
      () => this.updateMessages(),
      { deep: true },
    );

    this.updateMessages();

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
    this.messages.value = msgs;
  }

  async send(): Promise<void> {
    const text = this.query.value.trim();
    if (!text) return;

    this.query.value = '';
    await this.persona.addUserMessage('', text, {
      workflowId: this.activeWorkflowId.value || undefined,
      agentId:    this.activeAgentId.value || undefined,
    });
  }

  /** Clear all messages and reset the thread so the next send starts a fresh conversation. */
  resetConversation(): void {
    // Capture threadId before clearing so the backend can delete the right graph
    const oldThreadId = this.persona.getThreadId();

    this.messages.value = [];
    this.persona.messages.splice(0);
    this.persona.clearThreadId();

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
