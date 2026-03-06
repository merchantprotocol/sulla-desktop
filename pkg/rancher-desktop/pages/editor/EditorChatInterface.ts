// EditorChatInterface.ts — Lightweight chat controller for the editor's dev-editor channel
import { ref, watch, computed } from 'vue';
import { getAgentPersonaRegistry, type ChatMessage, type AgentRegistryEntry } from '@pkg/agent';

const DEV_EDITOR_CHANNEL = 'dev-editor';

export class EditorChatInterface {
  private readonly registry = getAgentPersonaRegistry();

  readonly query = ref('');
  readonly messages = ref<ChatMessage[]>([]);

  private watcher: ReturnType<typeof watch> | null = null;

  readonly graphRunning = computed(() => {
    const persona = this.registry.getPersonaService(DEV_EDITOR_CHANNEL);
    return persona?.graphRunning.value ?? false;
  });

  readonly loading = computed(() => {
    return this.registry.isLoading(DEV_EDITOR_CHANNEL);
  });

  constructor() {
    // Ensure the dev-editor agent entry exists in the registry
    this.ensureRegistryEntry();

    // Create/get the persona service (connects to WS automatically)
    this.registry.getOrCreatePersonaService(DEV_EDITOR_CHANNEL);

    // Watch persona messages and mirror into our ref
    this.watcher = watch(
      () => this.registry.getPersonaService(DEV_EDITOR_CHANNEL)?.messages.length ?? 0,
      () => this.updateMessages(),
    );

    this.updateMessages();
  }

  private ensureRegistryEntry(): void {
    const existing = this.registry.state.agents.find(a => a.agentId === DEV_EDITOR_CHANNEL);
    if (!existing) {
      this.registry.upsertAgent({
        isRunning:       true,
        agentId:         DEV_EDITOR_CHANNEL,
        agentName:       'Agent Workbench',
        templateId:      'glass-core',
        emotion:         'calm',
        status:          'online',
        tokensPerSecond: 847,
        totalTokensUsed: 0,
        temperature:     0.7,
        messages:        [],
        loading:         false,
      } as AgentRegistryEntry);
    }
  }

  private updateMessages(): void {
    const persona = this.registry.getPersonaService(DEV_EDITOR_CHANNEL);
    this.messages.value = persona ? [...persona.messages] : [];
  }

  async send(): Promise<void> {
    const text = this.query.value.trim();
    if (!text) return;

    this.query.value = '';

    const persona = this.registry.getPersonaService(DEV_EDITOR_CHANNEL);
    if (!persona) {
      console.warn('[EditorChatInterface] No persona service for dev-editor');
      return;
    }

    await persona.addUserMessage('', text);
  }

  stop(): void {
    const persona = this.registry.getPersonaService(DEV_EDITOR_CHANNEL);
    if (persona) {
      persona.emitStopSignal(DEV_EDITOR_CHANNEL);
      persona.graphRunning.value = false;
      this.registry.setLoading(DEV_EDITOR_CHANNEL, false);
    }
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher();
      this.watcher = null;
    }
  }
}
