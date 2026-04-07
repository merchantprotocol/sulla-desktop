// ChatInterface.ts
import { ref, computed, watch } from 'vue';
import { AgentPersonaService } from '@pkg/agent';
import type { PersonaSidebarAsset } from '@pkg/agent';
import { getAgentPersonaRegistry, AgentPersonaRegistry, type ChatMessage as RegistryChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { chatLogger as console } from '@pkg/agent/utils/agentLogger';
import { ChatMessageQueue, createMessageQueue, type QueuedMessage } from './ChatMessageQueue';
import type { PendingAttachment } from './AgentComposer.vue';

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
  private readonly messageQueue: ChatMessageQueue;

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

    // Initialize message queue
    this.messageQueue = createMessageQueue();

    // Restore threadId from localStorage so the next message reuses the same backend thread.
    // If none exists, generate one immediately so thread-ID filtering works from the start
    // and messages from other tabs don't leak into this persona.
    this.persona.restoreThreadId();
    if (!this.persona.getThreadId()) {
      this.persona.setThreadId(`thread_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`);
    }

    // Restore persisted messages from localStorage
    this.restoreMessages();

    // Watch persona messages for persistence
    watch(() => this.persona.messages, () => {
      this.messages.value = [...this.persona.messages];
      this.persistMessages();
    }, { deep: true });

    // Watch graphRunning to process next queued message when current one completes
    watch(() => this.persona.graphRunning.value, (isRunning) => {
      if (!isRunning && this.messageQueue.hasPendingMessages.value) {
        console.log('[ChatInterface] Graph finished, processing next queued message');
        this.processNextQueuedMessage();
      }
    });

    // Also watch loading state - when model finishes initializing, process queue
    watch(() => this.loading.value, (isLoading) => {
      if (!isLoading && !this.persona.graphRunning.value && this.messageQueue.hasPendingMessages.value) {
        console.log('[ChatInterface] Model ready, processing next queued message');
        this.processNextQueuedMessage();
      }
    });

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
    // Clear message queue
    this.messageQueue.clear();
    // Reset the "has sent" flag so the empty-state composer appears
    this.hasSentMessage.value = false;
    localStorage.removeItem(this.hasSentMessageKey);
  }

  dispose(): void {
    this.persona.stopListening();
  }

  stop(): void {
    console.log(`[ChatInterface:stop] channelId=${this.channelId}, graphRunning was ${this.persona.graphRunning.value}`);
    this.persona.emitStopSignal(this.channelId);
    this.persona.graphRunning.value = false;
    // Clear the queue when stopping
    this.messageQueue.clear();
    console.log(`[ChatInterface:stop] graphRunning now ${this.persona.graphRunning.value}, queue cleared`);
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

  /**
   * Send a message. If the graph is currently running, the message will be
   * queued and sent automatically when the current processing completes.
   */
  async send(metadata?: Record<string, unknown>, attachments?: Array<{ mediaType: string; base64: string }>): Promise<void> {
    if (!this.query.value.trim() && !attachments?.length) return;

    const text = this.query.value;

    // If graph is running OR model is still loading/initializing, queue the message
    if (this.persona.graphRunning.value || this.loading.value) {
      console.log(`[ChatInterface:send] Busy (graphRunning=${this.persona.graphRunning.value}, loading=${this.loading.value}), queuing message: ${ text.slice(0, 50) }...`);
      this.messageQueue.enqueue(text, attachments as PendingAttachment[], metadata);
      this.query.value = '';
      return;
    }

    // Send immediately
    await this.sendMessageInternal(text, metadata, attachments);
  }

  /**
   * Internal method to send a message immediately
   */
  private async sendMessageInternal(
    text: string,
    metadata?: Record<string, unknown>,
    attachments?: Array<{ mediaType: string; base64: string }>,
  ): Promise<void> {
    this.query.value = '';

    if (!this.hasSentMessage.value) {
      this.hasSentMessage.value = true;
      localStorage.setItem(this.hasSentMessageKey, 'true');
    }

    // Include attachments in metadata so the backend can build ContentBlock arrays
    const sendMetadata = attachments?.length
      ? { ...metadata, attachments: attachments.map(a => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mediaType, data: a.base64 } })) }
      : metadata;

    await this.persona.addUserMessage('', text, sendMetadata);
  }

  /**
   * Process the next queued message when graph finishes
   */
  private async processNextQueuedMessage(): Promise<void> {
    const nextMessage = this.messageQueue.shift();
    if (!nextMessage) return;

    console.log(`[ChatInterface:processNextQueuedMessage] Sending queued message: ${ nextMessage.content.slice(0, 50) }...`);

    const attachments = nextMessage.attachments?.map(a => ({
      mediaType: a.mediaType,
      base64:    a.base64,
    }));

    await this.sendMessageInternal(nextMessage.content, nextMessage.metadata, attachments);
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

  /**
   * Inject a queued message into the running graph's state immediately.
   * The message is removed from the queue and appended to state.messages
   * without interrupting or restarting the graph.  If the graph has already
   * finished (race condition), falls back to a normal send that triggers execution.
   */
  async injectQueuedMessage(messageId: string): Promise<void> {
    const msg = this.messageQueue.getById(messageId);
    if (!msg) return;

    this.messageQueue.dequeue(messageId);

    const attachments = msg.attachments?.map(a => ({
      mediaType: a.mediaType,
      base64:    a.base64,
    }));

    const metadata = attachments?.length
      ? { ...msg.metadata, attachments: attachments.map(a => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mediaType, data: a.base64 } })) }
      : msg.metadata;

    if (this.persona.graphRunning.value) {
      // Graph still running — inject without triggering execution
      console.log(`[ChatInterface:injectQueuedMessage] Injecting into running graph: ${ msg.content.slice(0, 50) }...`);
      await this.persona.injectMessage(msg.content, metadata);
    } else {
      // Graph already finished (race condition) — fall back to normal send
      console.log(`[ChatInterface:injectQueuedMessage] Graph not running, falling back to normal send: ${ msg.content.slice(0, 50) }...`);
      await this.sendMessageInternal(msg.content, metadata, attachments);
    }
  }

  /**
   * Register a listener for direct speak event delivery.
   * Bypasses the messages array watcher for lower-latency TTS triggering.
   * Returns an unsubscribe function.
   */
  onSpeakDispatch(cb: (text: string, threadId: string, pipelineSequence: number | null) => void): () => void {
    return this.persona.addSpeakListener(cb);
  }
}
