// EditorChatInterface.ts — Chat controller for the workbench page.
// Routes all messages through the 'workbench' channel so they hit
// the agent assigned to the workbench trigger.
import { ref, watch, computed } from 'vue';
import { AgentPersonaRegistry, type ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { AgentPersonaService } from '@pkg/agent';
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';

const WORKBENCH_CHANNEL = 'workbench';

export type WorkflowExecutionEventHandler = (event: {
  type: string;
  nodeId?: string;
  nodeLabel?: string;
  output?: unknown;
  error?: string;
  threadId?: string;
  sourceId?: string;
  targetId?: string;
  /** Present on node_thinking events */
  content?: string;
  role?: 'assistant' | 'system';
  kind?: string;
  timestamp: string;
}) => void;

export class EditorChatInterface {
  private readonly registry: AgentPersonaRegistry;
  private readonly persona: AgentPersonaService;

  readonly query = ref('');
  readonly messages = ref<ChatMessage[]>([]);

  /** When set, the agent will only see this workflow in list/execute tools */
  readonly activeWorkflowId = ref<string | null>(null);

  /** When set, overrides which agent handles messages on the backend */
  readonly activeAgentId = ref<string | null>(null);

  private watcher: ReturnType<typeof watch> | null = null;
  private wsUnsub: (() => void) | null = null;
  private workflowEventHandler: WorkflowExecutionEventHandler | null = null;

  readonly graphRunning = computed(() => {
    return this.persona.graphRunning.value;
  });

  readonly waitingForUser = computed(() => {
    return this.persona.waitingForUser.value;
  });

  readonly loading = ref(false);

  constructor() {
    // Create a minimal registry just for the persona service's internal needs
    this.registry = new AgentPersonaRegistry();
    this.persona = this.registry.getOrCreatePersonaService(WORKBENCH_CHANNEL);

    // Watch the persona's messages and mirror into our ref
    this.watcher = watch(
      () => this.persona.messages.length,
      () => this.updateMessages(),
    );

    this.updateMessages();

    // Listen for workflow execution events on the workbench channel
    const ws = getWebSocketClientService();
    this.wsUnsub = ws.onMessage(WORKBENCH_CHANNEL, (msg) => {
      if (msg.type === 'workflow_execution_event' && this.workflowEventHandler) {
        const data = msg.data as any;
        this.workflowEventHandler(data);
      }
    });
  }

  /** Register a handler for workflow execution events (node_started, node_completed, etc.) */
  onWorkflowEvent(handler: WorkflowExecutionEventHandler): void {
    this.workflowEventHandler = handler;
  }

  private updateMessages(): void {
    this.messages.value = [...this.persona.messages];
  }

  async send(): Promise<void> {
    const text = this.query.value.trim();
    if (!text) return;

    this.query.value = '';
    await this.persona.addUserMessage('', text, {
      workflowId: this.activeWorkflowId.value || undefined,
      agentId: this.activeAgentId.value || undefined,
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
        type: 'new_conversation',
        data: { threadId: oldThreadId },
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
