// ChatInterface.ts
import { ref, computed, watch } from 'vue';
import { AgentPersonaService } from '@pkg/agent';
import type { PersonaSidebarAsset } from '@pkg/agent';
import { AgentPersonaRegistry, type ChatMessage as RegistryChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';

export type ChatMessage = RegistryChatMessage;

const SULLA_DESKTOP_CHANNEL = 'sulla-desktop';
const MESSAGES_STORAGE_KEY = `chat_messages_${ SULLA_DESKTOP_CHANNEL }`;
const MAX_PERSISTED_MESSAGES = 200;

export class ChatInterface {
  private readonly persona:  AgentPersonaService;
  private readonly registry: AgentPersonaRegistry;

  readonly query = ref('');
  readonly transcriptEl = ref<HTMLElement | null>(null);

  readonly currentAgentId = computed(() => SULLA_DESKTOP_CHANNEL);

  readonly messages = ref<ChatMessage[]>([]);

  constructor() {
    this.registry = new AgentPersonaRegistry();
    this.persona = this.registry.getOrCreatePersonaService(SULLA_DESKTOP_CHANNEL);

    // Restore threadId from localStorage so the next message reuses the same backend thread
    this.persona.restoreThreadId();

    // Restore persisted messages from localStorage
    this.restoreMessages();

    watch(() => this.persona.messages.length, () => {
      this.messages.value = [...this.persona.messages];
      this.persistMessages();
    });

    this.messages.value = [...this.persona.messages];
  }

  private persistMessages(): void {
    try {
      // Strip image dataUrls to avoid blowing localStorage limits
      const toStore = this.persona.messages.slice(-MAX_PERSISTED_MESSAGES).map((m) => {
        if (m.image) {
          return { ...m, image: { ...m.image, dataUrl: '' } };
        }
        return m;
      });
      localStorage.setItem(MESSAGES_STORAGE_KEY, JSON.stringify(toStore));
    } catch { /* storage full — silently degrade */ }
  }

  private restoreMessages(): void {
    try {
      const raw = localStorage.getItem(MESSAGES_STORAGE_KEY);
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
        console.log(`[ChatInterface] Restored ${ parsed.length } messages from localStorage`);
      }
    } catch { /* corrupt data — start fresh */ }
  }

  readonly graphRunning = computed(() => {
    return this.persona.graphRunning.value;
  });

  readonly stopReason = computed(() => {
    return this.persona.stopReason.value;
  });

  readonly loading = computed(() => {
    return this.registry.isLoading(SULLA_DESKTOP_CHANNEL);
  });

  readonly currentActivity = computed(() => {
    return this.persona.currentActivity.value;
  });

  readonly showContinueButton = computed(() => {
    return this.persona.stopReason.value === 'max_loops' && !this.persona.graphRunning.value;
  });

  /** Active sidebar assets (iframes, documents) managed by the persona service */
  readonly activeAssets = computed<PersonaSidebarAsset[]>(() => {
    return [...this.persona.activeAssets];
  });

  readonly threadId = computed(() => {
    return this.persona.getThreadId();
  });

  // Track if user has ever sent a message (persisted in localStorage)
  private readonly hasSentMessageKey = 'chat_has_sent_message';
  private hasSentMessage = ref(localStorage.getItem(this.hasSentMessageKey) === 'true');

  readonly hasMessages = computed(() => {
    return this.hasSentMessage.value || this.messages.value.length > 0;
  });

  newChat(): void {
    // Clear backend thread reference
    this.persona.clearThreadId();
    // Clear in-memory messages
    this.persona.clearMessages();
    this.messages.value = [];
    // Clear persisted messages
    try {
      localStorage.removeItem(MESSAGES_STORAGE_KEY);
    } catch { /* ignore */ }
    // Reset the "has sent" flag so the empty-state composer appears
    this.hasSentMessage.value = false;
    localStorage.removeItem(this.hasSentMessageKey);
  }

  dispose(): void {
    this.persona.stopListening();
  }

  stop(): void {
    this.persona.emitStopSignal(SULLA_DESKTOP_CHANNEL);
    this.persona.graphRunning.value = false;
  }

  continueRun(): void {
    this.persona.emitContinueRun();
  }

  setAssetCollapsed(assetId: string, collapsed: boolean): void {
    this.persona.setAssetCollapsed(assetId, collapsed);
  }

  removeAsset(assetId: string): void {
    this.persona.removeAsset(assetId);
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
