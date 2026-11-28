// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// ChatInterface.ts
import { ref, computed, watch, type ComputedRef } from 'vue';

import { ChatMessageQueue, createMessageQueue, type PendingAttachment, type QueuedMessage } from './ChatMessageQueue';

import { AgentPersonaService } from '@pkg/agent';
import type { PersonaSidebarAsset } from '@pkg/agent';
import { getAgentPersonaRegistry, AgentPersonaRegistry, type ChatMessage as RegistryChatMessage } from '@pkg/agent/database/registry/AgentPersonaRegistry';
import { chatLogger as console } from '@pkg/agent/utils/agentLogger';

import { touchChatStorageScope } from './ChatStorageGc';

import type { SpeakListener } from '@pkg/agent/database/models/MessageDispatcher';
import { MessageWindow } from '../chat/messages/MessageWindow';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import { newHumanSendId, type HumanSendDispatch, type HumanSendPath, type HumanSendReceipt, type HumanSendRoute } from '@pkg/shared/HumanSend';

export type ChatMessage = RegistryChatMessage;

const DEFAULT_CHANNEL = 'sulla-desktop';
const MAX_PERSISTED_MESSAGES = 200;
const MAX_PERSISTED_TOOL_CHARS = 20_000;

function truncateForStorage(v: unknown): unknown {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  if (s.length <= MAX_PERSISTED_TOOL_CHARS) return v;
  return `${ s.slice(0, MAX_PERSISTED_TOOL_CHARS) }\n\n[truncated ${ s.length - MAX_PERSISTED_TOOL_CHARS } chars]`;
}

export class ChatInterface {
  private readonly persona:            AgentPersonaService;
  private readonly registry:           AgentPersonaRegistry;
  private readonly channelId:          string;
  private readonly tabId?:             string;
  /** Unique key for this tab's localStorage — scoped by tabId when provided */
  private readonly storageScope:       string;
  private readonly messagesStorageKey: string;
  private readonly queueStorageKey: string;
  private readonly messageQueue:       ChatMessageQueue;
  private readonly onTabClosed:        (event: Event) => void;
  private readonly stopHumanSendReceipt: () => void;
  private readonly messageWindow = new MessageWindow();
  private queueDrainSuspended = false;
  private pendingSteerDispatch: Promise<void> = Promise.resolve();

  readonly query = ref('');
  readonly transcriptEl = ref<HTMLElement | null>(null);

  readonly currentAgentId: ComputedRef<string>;

  readonly messages = ref<ChatMessage[]>([]);
  readonly messagesRevision: ComputedRef<number>;

  /**
   * @param channelId  WebSocket channel (shared across tabs, e.g. 'sulla-desktop')
   * @param tabId      Optional per-tab identifier. When provided, localStorage keys
   *                   (messages, threadId, hasSentMessage) are scoped to this tab so
   *                   multiple chat tabs can coexist independently.
   */
  constructor(channelId: string = DEFAULT_CHANNEL, tabId?: string) {
    this.channelId = channelId;
    this.tabId = tabId;
    // Use tabId for storage scoping when available, otherwise fall back to channelId
    this.storageScope = tabId ? `${ channelId }_${ tabId }` : channelId;
    touchChatStorageScope(this.storageScope);
    this.messagesStorageKey = `chat_messages_${ this.storageScope }`;
    this.queueStorageKey = `chat_pending_messages_${ this.storageScope }`;
    this.currentAgentId = computed(() => this.channelId);
    this.hasSentMessageKey = `chat_has_sent_message_${ this.storageScope }`;
    this.hasSentMessage = ref(localStorage.getItem(this.hasSentMessageKey) === 'true');
    this.registry = getAgentPersonaRegistry();
    this.persona = this.registry.getOrCreatePersonaService(channelId, tabId);
    this.onTabClosed = (event: Event) => {
      if ((event as CustomEvent<{ tabId?: string }>).detail?.tabId === this.tabId && this.tabId) {
        this.registry.release(this.channelId, this.tabId);
      }
    };
    window.addEventListener('sulla:chat-tab-closed', this.onTabClosed);
    this.messagesRevision = computed(() => this.persona.messagesRevision.value);

    // Initialize message queue
    this.messageQueue = createMessageQueue(messages => this.persistQueuedMessages(messages));
    this.restoreQueuedMessages();
    this.stopHumanSendReceipt = this.persona.onHumanSendReceipt(receipt => this.handleHumanSendReceipt(receipt));

    // Restore threadId from localStorage so the next message reuses the same backend thread.
    // If none exists, generate one immediately so thread-ID filtering works from the start
    // and messages from other tabs don't leak into this persona.
    this.persona.restoreThreadId();
    if (!this.persona.getThreadId()) {
      this.persona.setThreadId(`thread_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`);
    }

    // Restore persisted messages from localStorage
    this.restoreMessages();
    this.trimMessages();

    // Mirror explicit message revisions instead of deep-watching the full
    // transcript. A deep watcher traversed every historical message for every
    // stream delta before this callback even ran, recreating the renderer
    // starvation that the persistence debounce was meant to prevent.
    watch(() => this.persona.messagesRevision.value, () => {
      this.trimMessages();
      this.messages.value = this.persona.messages;
      this.schedulePersist();
    });

    // Watch graphRunning to process next queued message when current one completes
    watch(() => this.persona.graphRunning.value, (isRunning) => {
      if (isRunning) this.resumePendingSteer();
      if (!this.queueDrainSuspended && !isRunning && this.messageQueue.hasPendingMessages.value) {
        console.log('[ChatInterface] Graph finished, processing next queued message');
        this.processNextQueuedMessage();
      }
    });

    // Also watch loading state - when model finishes initializing, process queue
    watch(() => this.loading.value, (isLoading) => {
      if (!isLoading && this.persona.graphRunning.value) this.resumePendingSteer();
      if (!this.queueDrainSuspended && !isLoading && !this.persona.graphRunning.value && this.messageQueue.hasPendingMessages.value) {
        console.log('[ChatInterface] Model ready, processing next queued message');
        this.processNextQueuedMessage();
      }
    });

    this.messages.value = this.persona.messages;
    if (this.persona.graphRunning.value) this.resumePendingSteer();
  }

  private trimMessages(): void {
    const bounded = this.messageWindow.trim(this.persona.messages);
    if (bounded.length !== this.persona.messages.length) this.persona.messages.splice(0, this.persona.messages.length, ...bounded);
  }

  /** Trailing-debounce timer for persistMessages — see the messages watcher. */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistMessages();
    }, 500);
  }

  private persistMessages(): void {
    try {
      // Strip image dataUrls, truncate large HTML, and cap tool result/output
      // so a single giant payload can't wipe out localStorage or, on restore,
      // OOM the renderer rehydrating the reactive state.
      const toStore = this.persona.messages.slice(-MAX_PERSISTED_MESSAGES).map((m) => {
        if (m.image) {
          return { ...m, image: { ...m.image, dataUrl: '' } };
        }
        if (m.kind === 'html' && m.content.length > 50_000) {
          return { ...m, content: '[HTML content too large to persist]' };
        }
        if (m.toolCard && (m.toolCard.result !== undefined || m.toolCard.output !== undefined)) {
          return {
            ...m,
            toolCard: {
              ...m.toolCard,
              result: m.toolCard.result !== undefined ? truncateForStorage(m.toolCard.result) : undefined,
              output: m.toolCard.output !== undefined ? truncateForStorage(m.toolCard.output) as string : undefined,
            },
          };
        }
        return m;
      });
      localStorage.setItem(this.messagesStorageKey, JSON.stringify(toStore));
    } catch { /* storage full — silently degrade */ }
  }

  private persistQueuedMessages(messages: readonly QueuedMessage[]): void {
    try {
      if (!messages.length) localStorage.removeItem(this.queueStorageKey);
      else localStorage.setItem(this.queueStorageKey, JSON.stringify(messages));
    } catch (error) {
      console.warn('[ChatInterface] could not persist pending messages; keeping them in the live queue:', error);
    }
  }

  private restoreQueuedMessages(): void {
    try {
      const raw = localStorage.getItem(this.queueStorageKey);
      if (raw) this.messageQueue.restore(JSON.parse(raw));
    } catch (error) {
      console.warn('[ChatInterface] could not restore pending messages:', error);
    }
  }

  private restoreMessages(): void {
    try {
      const raw = localStorage.getItem(this.messagesStorageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ChatMessage[];
      if (Array.isArray(parsed) && parsed.length > 0 && this.persona.messages.length === 0) {
        // Mark any stale running tool cards as failed
        for (const m of parsed) {
          if (m.toolCard?.status === 'running') {
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

  /** Retained for back-compat; always empty — tabs moved to main-process TabRegistry. */
  readonly activeAssets = computed<PersonaSidebarAsset[]>(() => []);

  readonly threadId = computed(() => {
    return this.persona.getThreadId();
  });

  // ─── Token + cost tracking (read-only pass-through) ─────────────
  // Surfaces are mirrored from AgentPersonaService.state so that
  // renderer-side code (new chat's TokenUsageModal, any other consumer)
  // can read without drilling into the private persona field.
  readonly totalTokensUsed     = computed(() => this.persona.state.totalTokensUsed);
  readonly totalPromptTokens   = computed(() => this.persona.state.totalPromptTokens);
  readonly totalCompletionTokens = computed(() => this.persona.state.totalCompletionTokens);
  readonly totalInputCost      = computed(() => this.persona.state.totalInputCost);
  readonly totalOutputCost     = computed(() => this.persona.state.totalOutputCost);
  readonly totalCost           = computed(() => this.persona.state.totalCost);
  readonly responseCount       = computed(() => this.persona.state.responseCount);
  readonly averageResponseTime = computed(() => this.persona.state.averageResponseTime);
  readonly tokensPerSecond     = computed(() => this.persona.state.tokensPerSecond);

  // Track if user has ever sent a message (persisted in localStorage)
  private readonly hasSentMessageKey: string;
  private hasSentMessage:             ReturnType<typeof ref<boolean>>;

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
    window.removeEventListener('sulla:chat-tab-closed', this.onTabClosed);
    this.stopHumanSendReceipt();
    // Flush any debounce-pending persist so the tail of the last response
    // isn't lost when the tab/component goes away inside the 500ms window.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persistMessages();
    }
    this.persona.stopListening();
  }

  stop(cancelSendIds: string[] = []): void {
    const threadId = this.persona.getThreadId();
    console.log(`[ChatInterface:stop] channelId=${ this.channelId }, tabId=${ this.tabId ?? '(none)' }, threadId=${ threadId ?? '(none)' }, graphRunning was ${ this.persona.graphRunning.value }`);
    this.queueDrainSuspended = true;
    if (threadId) {
      const pendingMessages = this.messageQueue.pendingMessages.value;
      const queuedSendIds = pendingMessages
        .filter(message => message.metadata?.deliveryStatus === 'delivering')
        .flatMap(message => [message.metadata?.sendId, ...(Array.isArray(message.metadata?.coalescedSendIds) ? message.metadata.coalescedSendIds : [])])
        .filter((sendId): sendId is string => typeof sendId === 'string' && !!sendId);
      const sendIds = [...new Set([...cancelSendIds, ...queuedSendIds])];
      for (const message of pendingMessages) {
        const sendId = message.metadata?.sendId;
        if (typeof sendId === 'string') this.updateLegacyQueuedSend(sendId, { deliveryStatus: 'pending', cancelledByStop: true });
      }
      const cancel = this.persona.cancelHumanSends(sendIds);
      void cancel.finally(() => this.persona.emitStopSignal(this.channelId));
    } else {
      // Never emit an unscoped stop. Multiple tabs intentionally share one
      // channel, so a missing thread id must fail closed instead of risking a
      // channel-wide abort in an older backend.
      console.warn(`[ChatInterface:stop] ignored unscoped stop for channelId=${ this.channelId }, tabId=${ this.tabId ?? '(none)' }`);
    }
    this.persona.graphRunning.value = false;
    console.log(`[ChatInterface:stop] graphRunning now ${ this.persona.graphRunning.value }, queued messages retained for explicit retry`);
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
   * Send a message. Running graphs accept ordinary input through the existing steer path.
   * A visible legacy queue row remains until the backend receipt confirms acceptance.
   */
  async send(metadata?: Record<string, unknown>, attachments?: { mediaType: string; base64: string }[], humanSend?: HumanSendDispatch): Promise<HumanSendPath | undefined> {
    if (!this.query.value.trim() && !attachments?.length && !(Array.isArray(metadata?.fileReferences) && metadata.fileReferences.length)) return undefined;

    const text = this.query.value;
    const running = this.persona.graphRunning.value;
    // CLI live-steer transports accept text only. Keep any binary attachment
    // in the visible fresh-turn queue so it reaches a provider that can read it.
    const routeChanging = !!(metadata?.agentId || metadata?.workflowId || metadata?.useCaseIntent || metadata?.inputSource === 'voice' || (attachments?.length ?? 0) > 0);
    const route: HumanSendRoute = running ? routeChanging ? 'new_turn' : 'steer' : 'idle';
    const path: HumanSendPath = running ? routeChanging ? 'queued' : 'injected' : 'sent_fresh';
    const delivery: HumanSendDispatch = {
      sendId: humanSend?.sendId ?? newHumanSendId(),
      ...(humanSend?.coalescedSendIds?.length ? { coalescedSendIds: [...humanSend.coalescedSendIds] } : {}),
      route,
      enqueuedAtMs: humanSend?.enqueuedAtMs ?? Date.now(),
      path,
    };
    this.query.value = '';
    this.recordHumanSendEnqueued(delivery);
    this.queueDrainSuspended = false;
    // Keep a route-changing fresh send recoverable if the renderer's running
    // flag lagged the backend and the backend asks us to wait for its active
    // run. It stays hidden while delivery is in flight, then becomes a visible
    // waiting row only if the backend rejects it as queued.
    if (routeChanging && path === 'sent_fresh') {
      this.messageQueue.enqueue(text, attachments?.map((attachment, index) => ({
        name: `Attachment ${ index + 1 }`, mediaType: attachment.mediaType, base64: attachment.base64, preview: '',
      })), { ...metadata, ...delivery, deliveryStatus: 'delivering', cancelledByStop: false });
    }

    if (path === 'queued') {
      this.messageQueue.enqueue(text, attachments?.map((attachment, index) => ({
        name: `Attachment ${ index + 1 }`, mediaType: attachment.mediaType, base64: attachment.base64, preview: '',
      })), {
        ...metadata, ...delivery, deliveryStatus: 'pending', cancelledByStop: false,
      });
      if (!humanSend) this.recordSendHop(path);
      return path;
    }

    if (path === 'injected') {
      this.messageQueue.enqueue(text, attachments?.map((attachment, index) => ({
        name: `Attachment ${ index + 1 }`, mediaType: attachment.mediaType, base64: attachment.base64, preview: '',
      })), {
        ...metadata, ...delivery, deliveryStatus: 'delivering', cancelledByStop: false,
      });
      let actualPath: HumanSendPath = 'injected';
      this.pendingSteerDispatch = this.pendingSteerDispatch.catch(() => undefined).then(async() => {
        actualPath = await this.injectMessage(text, attachments, metadata, delivery, false);
      });
      try {
        await this.pendingSteerDispatch;
      } catch (error) {
        this.updateLegacyQueuedSend(delivery.sendId, { deliveryStatus: 'pending' });
        throw error;
      }
      if (!humanSend) this.recordSendHop(actualPath);
      return actualPath;
    }

    try {
      await this.sendMessageInternal(text, metadata, attachments, delivery);
    } catch (error) {
      if (routeChanging) this.updateLegacyQueuedSend(delivery.sendId, { deliveryStatus: 'pending' });
      throw error;
    }
    if (!humanSend) this.recordSendHop(path);
    return path;
  }

  /**
   * Internal method to send a message immediately
   */
  private async sendMessageInternal(
    text: string,
    metadata?: Record<string, unknown>,
    attachments?: { mediaType: string; base64: string }[],
    humanSend?: HumanSendDispatch,
  ): Promise<void> {
    this.query.value = '';

    if (!this.hasSentMessage.value) {
      this.hasSentMessage.value = true;
      // Persisting the "has sent" flag is a convenience only — it must NEVER
      // abort the send. A full localStorage (QuotaExceededError) would otherwise
      // throw here, AFTER the reactive flag flip switched the UI to the chat
      // thread but BEFORE addUserMessage() below, leaving a blank thread and a
      // message that never sent. Swallow the failure and proceed.
      try {
        localStorage.setItem(this.hasSentMessageKey, 'true');
      } catch (e) { console.warn('[ChatInterface] could not persist hasSentMessage flag:', e); }
    }

    // Include attachments in metadata so the backend can build ContentBlock arrays
    const sendMetadata = attachments?.length
      ? { ...metadata, attachments: attachments.map(a => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mediaType, data: a.base64 } })) }
      : metadata;

    if (humanSend) this.skipNextTranscriptTrim = true;
    if (!await this.persona.addUserMessage('', text, sendMetadata, humanSend)) throw new Error('Message could not be delivered.');
    this.schedulePersist();
  }

  /**
   * Process the next queued message when graph finishes
   */
  private async processNextQueuedMessage(): Promise<void> {
    const firstMessage = this.messageQueue.peek();
    if (firstMessage?.metadata?.deliveryStatus === 'delivering' || firstMessage?.metadata?.cancelledByStop === true) return;
    if (this.persona.graphRunning.value || !firstMessage) return;
    const nextMessage = this.messageQueue.shift();
    if (!nextMessage) return;

    let content = nextMessage.content;
    const coalescedSendIds: string[] = Array.isArray(nextMessage.metadata?.coalescedSendIds)
      ? nextMessage.metadata.coalescedSendIds.filter((id): id is string => typeof id === 'string')
      : [];

    // Voice backstop: fixed end-of-turn detection should already deliver a whole
    // utterance as one message, but if any voice fragments still slip into the queue,
    // coalesce leading consecutive voice-sourced (attachment-free) messages into a
    // single turn instead of firing a separate agent run per fragment. No-op for
    // typed messages (which aren't voice-tagged), so it can only help.
    if (nextMessage.metadata?.inputSource === 'voice' && !nextMessage.attachments?.length) {
      let peek = this.messageQueue.peek();
      while (peek && peek.metadata?.inputSource === 'voice' && !peek.attachments?.length) {
        const fragment = this.messageQueue.shift()!;
        content += ` ${ fragment.content }`;
        const fragmentSendId = fragment.metadata?.sendId;
        if (typeof fragmentSendId === 'string') coalescedSendIds.push(fragmentSendId);
        if (Array.isArray(fragment.metadata?.coalescedSendIds)) {
          coalescedSendIds.push(...fragment.metadata.coalescedSendIds.filter((id): id is string => typeof id === 'string'));
        }
        peek = this.messageQueue.peek();
      }
    }

    console.log('[ChatInterface:processNextQueuedMessage] Dispatching queued message');

    const attachments = nextMessage.attachments?.map(a => ({
      mediaType: a.mediaType,
      base64:    a.base64,
    }));
    const existingSendId = nextMessage.metadata?.sendId;
    const humanSend: HumanSendDispatch = {
      sendId: typeof existingSendId === 'string' && nextMessage.metadata?.cancelledByStop !== true ? existingSendId : newHumanSendId(),
      ...(coalescedSendIds.length ? { coalescedSendIds: [...new Set(coalescedSendIds.filter(id => id !== existingSendId))] } : {}),
      route: 'idle', path: 'sent_fresh',
      enqueuedAtMs: typeof nextMessage.metadata?.enqueuedAtMs === 'number' ? nextMessage.metadata.enqueuedAtMs : Date.now(),
    };
    const pending = this.messageQueue.enqueue(content, nextMessage.attachments, {
      ...nextMessage.metadata, ...humanSend, deliveryStatus: 'delivering', cancelledByStop: false,
    });
    if (typeof existingSendId !== 'string') this.recordHumanSendEnqueued(humanSend);
    try {
      await this.sendMessageInternal(content, nextMessage.metadata, attachments, humanSend);
      this.recordSendHop('sent_fresh');
    } catch (error) {
      this.updateLegacyQueuedSend(humanSend.sendId, { deliveryStatus: 'pending' });
      console.warn(`[ChatInterface] queued send ${ pending.id } was not accepted; keeping it visible for retry`);
      throw error;
    }
  }

  // ─── Queue Management ───────────────────────────────────────────

  /** Get the message queue for UI display */
  getQueue(): ChatMessageQueue {
    return this.messageQueue;
  }

  /** Remove a specific message from the queue */
  removeQueuedMessage(messageId: string): boolean {
    const queued = this.messageQueue.getById(messageId);
    const sendId = queued?.metadata?.sendId;
    const related = queued?.metadata?.coalescedSendIds;
    if (typeof sendId === 'string') void this.persona.cancelHumanSends([
      sendId, ...(Array.isArray(related) ? related.filter((id): id is string => typeof id === 'string') : []),
    ]);
    return this.messageQueue.dequeue(messageId);
  }

  /** Clear all pending messages */
  clearQueue(): void {
    const sendIds = this.messageQueue.pendingMessages.value
      .filter(message => message.metadata?.deliveryStatus === 'delivering')
      .flatMap(message => [message.metadata?.sendId, ...(Array.isArray(message.metadata?.coalescedSendIds) ? message.metadata.coalescedSendIds : [])])
      .filter((sendId): sendId is string => typeof sendId === 'string');
    if (sendIds.length) void this.persona.cancelHumanSends(sendIds);
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
    if (!msg || msg.metadata?.deliveryStatus === 'delivering') return;

    const attachments = msg.attachments?.map(a => ({ mediaType: a.mediaType, base64: a.base64 }));
    const metadata: Record<string, unknown> = { ...msg.metadata };
    const routeChanging = !!(metadata.agentId || metadata.workflowId || metadata.useCaseIntent || metadata.inputSource === 'voice' || (msg.attachments?.length ?? 0) > 0);
    const running = this.persona.graphRunning.value;
    if (running && routeChanging) return;
    const sendId = typeof metadata.sendId === 'string' && metadata.cancelledByStop !== true ? metadata.sendId : newHumanSendId();
    const oldCoalescedSendIds = Array.isArray(metadata.coalescedSendIds)
      ? metadata.coalescedSendIds.filter((id): id is string => typeof id === 'string')
      : [];
    const humanSend: HumanSendDispatch = {
      sendId,
      ...(oldCoalescedSendIds.length ? {
        coalescedSendIds: metadata.cancelledByStop === true ? oldCoalescedSendIds.map(() => newHumanSendId()) : oldCoalescedSendIds,
      } : {}),
      route: running ? 'steer' : 'idle',
      path: running ? 'injected' : 'sent_fresh',
      enqueuedAtMs: typeof metadata.enqueuedAtMs === 'number' && metadata.cancelledByStop !== true ? metadata.enqueuedAtMs : Date.now(),
    };
    Object.assign(metadata, humanSend, { deliveryStatus: 'delivering', cancelledByStop: false });
    this.queueDrainSuspended = false;
    this.messageQueue.updateMetadataById(msg.id, { ...humanSend, deliveryStatus: 'delivering', cancelledByStop: false });
    this.recordHumanSendEnqueued(humanSend);

    const sendMetadata = attachments?.length
      ? { ...metadata, attachments: attachments.map(a => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mediaType, data: a.base64 } })) }
      : metadata;
    try {
      if (running && humanSend.route === 'steer') {
        await this.injectMessage(msg.content, attachments, sendMetadata, humanSend, false);
      } else {
        await this.sendMessageInternal(msg.content, sendMetadata, attachments, humanSend);
      }
      this.recordSendHop(humanSend.path ?? (running ? 'injected' : 'sent_fresh'));
    } catch (error) {
      this.updateLegacyQueuedSend(humanSend.sendId, { deliveryStatus: 'pending' });
      throw error;
    }
  }

  private handleHumanSendReceipt(receipt: HumanSendReceipt): void {
    const queued = this.messageQueue.pendingMessages.value.find(message => message.metadata?.sendId === receipt.sendId);
    if (!queued) {
      if (receipt.status !== 'accepted') this.persona.removeOptimisticHumanMessage(receipt.sendId);
      return;
    }
    if (receipt.status === 'accepted') {
      this.messageQueue.dequeue(queued.id);
      if (!this.queueDrainSuspended && !this.persona.graphRunning.value && this.messageQueue.hasPendingMessages.value) {
        void this.processNextQueuedMessage();
      }
      return;
    }
    if (receipt.status === 'rejected' && receipt.route === 'new_turn') {
      this.persona.removeOptimisticHumanMessage(receipt.sendId);
      this.updateLegacyQueuedSend(receipt.sendId, { deliveryStatus: 'pending', cancelledByStop: false, route: 'new_turn', path: 'queued' });
      return;
    }
    this.persona.removeOptimisticHumanMessage(receipt.sendId);
    this.updateLegacyQueuedSend(receipt.sendId, { deliveryStatus: 'pending', cancelledByStop: true });
  }

  private updateLegacyQueuedSend(sendId: string, patch: Record<string, unknown>): void {
    this.messageQueue.updateMetadataBySendId(sendId, patch);
  }

  /** A refreshed renderer retries an unacknowledged plain-text steer against the same backend id. */
  private resumePendingSteer(): void {
    if (this.queueDrainSuspended || !this.persona.graphRunning.value) return;
    const queued = this.messageQueue.peek();
    if (!queued || queued.metadata?.deliveryStatus === 'delivering' || queued.metadata?.cancelledByStop === true) return;
    const metadata = queued.metadata ?? {};
    const routeChanging = !!(metadata.agentId || metadata.workflowId || metadata.useCaseIntent || metadata.inputSource === 'voice' || queued.attachments.length);
    if (routeChanging || metadata.route === 'new_turn') return;
    void this.injectQueuedMessage(queued.id).catch(error => console.warn('[ChatInterface] recovered steer could not be retried:', error));
  }

  /**
   * Inject a raw user message into the graph with the smart route:
   *   • graph running  → persona.injectMessage (WS `inject_message`)
   *                      appends to state.messages without starting a new run;
   *                      the graph picks it up on the next iteration.
   *   • graph idle     → sendMessageInternal (normal user turn)
   *
   * Used by the new chat's `ChatController.injectQueuedMessage` — the
   * queue lives client-side in the controller (not in messageQueue),
   * so we take raw text + attachments + metadata instead of a queue id.
   */
  async injectMessage(
    text: string,
    attachments?: { mediaType: string; base64: string }[],
    metadata?: Record<string, unknown>,
    humanSend?: HumanSendDispatch,
    recordEnqueued = true,
  ): Promise<HumanSendPath> {
    if (!text.trim() && !attachments?.length && !(Array.isArray(metadata?.fileReferences) && metadata.fileReferences.length)) return 'sent_fresh';

    const running = this.persona.graphRunning.value;
    const actualSend: HumanSendDispatch | undefined = humanSend ? {
      ...humanSend,
      route: running ? 'steer' : 'idle',
      path: running ? 'injected' : 'sent_fresh',
    } : undefined;
    if (actualSend && recordEnqueued) this.recordHumanSendEnqueued(actualSend);

    const fullMetadata = attachments?.length
      ? { ...metadata, attachments: attachments.map(a => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: a.mediaType, data: a.base64 } })) }
      : metadata;

    this.query.value = '';
    if (running) {
      console.log('[ChatInterface:injectMessage] Injecting into running graph');
      if (!await this.persona.injectMessage(text, fullMetadata, actualSend)) throw new Error('Message could not be delivered.');
      this.schedulePersist();
      return 'injected';
    } else {
      console.log('[ChatInterface:injectMessage] Graph idle, sending normally');
      await this.sendMessageInternal(text, fullMetadata, attachments, actualSend);
      return 'sent_fresh';
    }
  }

  private recordHumanSendEnqueued(send: HumanSendDispatch): void {
    const threadId = this.persona.getThreadId();
    if (!threadId) return;
    for (const sendId of [send.sendId, ...(send.coalescedSendIds ?? [])]) {
      ipcRenderer.send('human-send-wait:enqueued', { ...send, sendId, coalescedSendIds: undefined, threadId });
    }
  }

  private recordSendHop(route: HumanSendPath): void {
    const threadId = this.persona.getThreadId();
    if (!threadId) return;
    ipcRenderer.send('send-hop:log', {
      threadId,
      messageCount: this.persona.messages.length,
      route,
      marks: {},
    });
  }

  onHumanSendReceipt(listener: (receipt: import('@pkg/shared/HumanSend').HumanSendReceipt) => void): () => void {
    return this.persona.onHumanSendReceipt(listener);
  }

  cancelHumanSends(sendIds: string[]): Promise<boolean> {
    return this.persona.cancelHumanSends(sendIds);
  }

  /**
   * Register a listener for direct speak event delivery.
   * Bypasses the messages array watcher for lower-latency TTS triggering.
   * Returns an unsubscribe function.
   */
  onSpeakDispatch(cb: SpeakListener): () => void {
    return this.persona.addSpeakListener(cb);
  }
}
