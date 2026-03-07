// ChatInterface.ts
import { ref, computed, watch } from 'vue';
import { AgentPersonaService } from '@pkg/agent';
import { AgentPersonaRegistry, type ChatMessage as RegistryChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';

export type ChatMessage = RegistryChatMessage;

const SULLA_DESKTOP_CHANNEL = 'sulla-desktop';

export class ChatInterface {
  private readonly persona: AgentPersonaService;
  private readonly registry: AgentPersonaRegistry;

  readonly query = ref('');
  readonly transcriptEl = ref<HTMLElement | null>(null);

  readonly currentAgentId = computed(() => SULLA_DESKTOP_CHANNEL);

  readonly messages = ref<ChatMessage[]>([]);

  constructor() {
    // Create a minimal registry just for the persona service's internal needs
    this.registry = new AgentPersonaRegistry();
    this.persona = this.registry.getOrCreatePersonaService(SULLA_DESKTOP_CHANNEL);

    watch(() => this.persona.messages.length, () => {
      this.messages.value = [...this.persona.messages];
    });

    this.messages.value = [...this.persona.messages];
  }

  readonly graphRunning = computed(() => {
    return this.persona.graphRunning.value;
  });

  // Track if user has ever sent a message (persisted in localStorage)
  private readonly hasSentMessageKey = 'chat_has_sent_message';
  private hasSentMessage = ref(localStorage.getItem(this.hasSentMessageKey) === 'true');

  readonly hasMessages = computed(() => {
    return this.hasSentMessage.value || this.messages.value.length > 0;
  });

  dispose(): void {
    this.persona.stopListening();
  }

  stop(): void {
    this.persona.emitStopSignal(SULLA_DESKTOP_CHANNEL);
    this.persona.graphRunning.value = false;
  }

  async send(): Promise<void> {
    if (!this.query.value.trim()) return;

    const text = this.query.value;
    this.query.value = '';

    if (!this.hasSentMessage.value) {
      this.hasSentMessage.value = true;
      localStorage.setItem(this.hasSentMessageKey, 'true');
    }

    await this.persona.addUserMessage('', text);
  }
}
