// EditorChatInterface.ts — Chat controller for the workbench page.
// Routes all messages through the 'workbench' channel so they hit
// workflows with a 'workbench' trigger node.
import { ref, watch, computed } from 'vue';
import { AgentPersonaRegistry, type ChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { AgentPersonaService } from '@pkg/agent';

const WORKBENCH_CHANNEL = 'workbench';

export class EditorChatInterface {
  private readonly registry: AgentPersonaRegistry;
  private readonly persona: AgentPersonaService;

  readonly query = ref('');
  readonly messages = ref<ChatMessage[]>([]);

  private watcher: ReturnType<typeof watch> | null = null;

  readonly graphRunning = computed(() => {
    return this.persona.graphRunning.value;
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
  }

  private updateMessages(): void {
    this.messages.value = [...this.persona.messages];
  }

  async send(): Promise<void> {
    const text = this.query.value.trim();
    if (!text) return;

    this.query.value = '';
    await this.persona.addUserMessage('', text);
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
  }
}
