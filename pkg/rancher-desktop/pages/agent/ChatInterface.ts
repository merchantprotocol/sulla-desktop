// ChatInterface.ts
import { ref, computed, watch } from 'vue';
import { AgentPersonaService } from '@pkg/agent';
import type { PersonaSidebarAsset } from '@pkg/agent';
import { getAgentPersonaRegistry, AgentPersonaRegistry, type ChatMessage as RegistryChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';

export type ChatMessage = RegistryChatMessage;

const DEFAULT_CHANNEL = 'sulla-desktop';
const MAX_PERSISTED_MESSAGES = 200;

export class ChatInterface {
  private readonly persona:  AgentPersonaService;
  private readonly registry: AgentPersonaRegistry;
  private readonly channelId: string;
  /** Unique key for this tab's localStorage — scoped by tabId when provided */
  private readonly storageScope: string;
  private readonly messagesStorageKey: string;

  readonly query = ref('');
  readonly transcriptEl = ref<HTMLElement | null>(null);

  readonly currentAgentId: ReturnType<typeof computed<string>>;

  readonly messages = ref<ChatMessage[]>([]);

  /**
   * @param channelId  WebSocket channel (shared across tabs, e.g. 'sulla-desktop')
   * @param tabId      Optional per-tab identifier. When provided, localStorage keys
   *                   (messages, threadId, hasSentMessage) are scoped to this tab so
   *                   multiple chat tabs can coexist independently.
   */
  constructor(channelId: string = DEFAULT_CHANNEL, tabId?: string) {
    this.channelId = channelId;
    // Use tabId for storage scoping when available, otherwise fall back to channelId
    this.storageScope = tabId ? `${ channelId }_${ tabId }` : channelId;
    this.messagesStorageKey = `chat_messages_${ this.storageScope }`;
    this.currentAgentId = computed(() => this.channelId);
    this.hasSentMessageKey = `chat_has_sent_message_${ this.storageScope }`;
    this.hasSentMessage = ref(localStorage.getItem(this.hasSentMessageKey) === 'true');
    this.registry = getAgentPersonaRegistry();
    this.persona = this.registry.getOrCreatePersonaService(channelId, tabId);

    // Restore threadId from localStorage so the next message reuses the same backend thread.
    // If none exists, generate one immediately so thread-ID filtering works from the start
    // and messages from other tabs don't leak into this persona.
    this.persona.restoreThreadId();
    if (!this.persona.getThreadId()) {
      this.persona.setThreadId(`thread_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`);
    }

    // Restore persisted messages from localStorage
    this.restoreMessages();

    watch(() => this.persona.messages, () => {
      this.messages.value = [...this.persona.messages];
      this.persistMessages();
    }, { deep: true });

    this.messages.value = [...this.persona.messages];
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
    return this.registry.isLoading(this.channelId);
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
  private readonly hasSentMessageKey: string;
  private hasSentMessage: ReturnType<typeof ref<boolean>>;

  readonly hasMessages = computed(() => {
    return this.hasSentMessage.value || this.messages.value.some(m => m.kind !== 'voice_interim');
  });

  newChat(): void {
    // Clear backend thread reference
    this.persona.clearThreadId();
    // Generate a fresh threadId immediately so thread-ID filtering works
    // from the very first message and other tabs don't receive our responses.
    this.persona.setThreadId(`thread_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`);
    // Clear in-memory messages
    this.persona.clearMessages();
    this.messages.value = [];
    // Clear persisted messages
    try {
      localStorage.removeItem(this.messagesStorageKey);
    } catch { /* ignore */ }
    // Reset the "has sent" flag so the empty-state composer appears
    this.hasSentMessage.value = false;
    localStorage.removeItem(this.hasSentMessageKey);
  }

  dispose(): void {
    this.persona.stopListening();
  }

  stop(): void {
    this.persona.emitStopSignal(this.channelId);
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

  async send(metadata?: Record<string, unknown>): Promise<void> {
    if (!this.query.value.trim()) return;

    const text = this.query.value;
    this.query.value = '';

    if (!this.hasSentMessage.value) {
      this.hasSentMessage.value = true;
      localStorage.setItem(this.hasSentMessageKey, 'true');
    }

    await this.persona.addUserMessage('', text, metadata);
  }
}
