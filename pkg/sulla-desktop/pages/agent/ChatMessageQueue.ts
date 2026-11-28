// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// ChatMessageQueue.ts — Message queue for sequential processing with Windsurf-style UX
import { ref, computed, markRaw, toRaw } from 'vue';

export interface PendingAttachment {
  name:      string;
  mediaType: string;
  base64:    string;
  preview:   string;  // data: URL for thumbnail
}

export interface QueuedMessage {
  id:          string;
  content:     string;
  attachments: PendingAttachment[];
  metadata?:   Record<string, unknown>;
  timestamp:   number;
}

export class ChatMessageQueue {
  private readonly queue = ref<QueuedMessage[]>([]);
  private processing = ref(false);

  constructor(private readonly onChanged: (messages: readonly QueuedMessage[]) => void = () => {}) {}

  readonly pendingMessages = computed(() => this.queue.value);
  /** Queue rows awaiting dispatch; transient steers stay out of the chat UI. */
  readonly visiblePendingMessages = computed(() => this.queue.value.filter(message => message.metadata?.deliveryStatus !== 'delivering'));
  readonly hasVisiblePendingMessages = computed(() => this.visiblePendingMessages.value.length > 0);
  readonly visibleQueueLength = computed(() => this.visiblePendingMessages.value.length);
  readonly hasPendingMessages = computed(() => this.queue.value.length > 0);
  readonly isProcessing = computed(() => this.processing.value);
  readonly queueLength = computed(() => this.queue.value.length);

  /** Copy queue metadata to ordinary cloneable data before a queued send reaches IPC. */
  private plainMetadata(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
    if (value === null || typeof value !== 'object') return value;
    const raw = toRaw(value as object);
    const prior = seen.get(raw);
    if (prior) return prior;
    const copy: any = Array.isArray(raw) ? [] : {};
    seen.set(raw, copy);
    for (const key of Object.keys(raw)) copy[key] = this.plainMetadata((raw as any)[key], seen);
    return copy;
  }

  /**
   * Add a message to the queue
   */
  enqueue(content: string, attachments: PendingAttachment[] = [], metadata?: Record<string, unknown>): QueuedMessage {
    const message: QueuedMessage = {
      id:        `queued_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`,
      content,
      attachments,
      // markRaw keeps the plain copy from being re-wrapped by the deep queue ref, so shift() returns cloneable data.
      metadata: metadata ? markRaw(this.plainMetadata(metadata) as Record<string, unknown>) : undefined,
      timestamp: Date.now(),
    };

    this.queue.value.push(message);
    this.notifyChanged();
    this.notifyChanged();
    console.log(`[ChatMessageQueue] Enqueued message #${ this.queue.value.length }`);

    return message;
  }

  /**
   * Find a message by ID without removing it
   */
  getById(messageId: string): QueuedMessage | null {
    return this.queue.value.find(m => m.id === messageId) ?? null;
  }

  /**
   * Remove a specific message from the queue
   */
  dequeue(messageId: string): boolean {
    const index = this.queue.value.findIndex(m => m.id === messageId);
    if (index === -1) return false;

    const removed = this.queue.value.splice(index, 1)[0];
    this.notifyChanged();
    this.notifyChanged();
    console.log(`[ChatMessageQueue] Dequeued id=${ removed.id }`);

    return true;
  }

  /**
   * Get the next message to process (FIFO)
   */
  peek(): QueuedMessage | null {
    return this.queue.value[0] || null;
  }

  /**
   * Remove and return the next message (FIFO)
   */
  shift(): QueuedMessage | null {
    if (this.queue.value.length === 0) return null;

    const message = this.queue.value.shift()!;
    this.notifyChanged();
    this.notifyChanged();
    console.log(`[ChatMessageQueue] Processing id=${ message.id }`);

    return message;
  }

  /**
   * Clear all pending messages
   */
  clear(): void {
    const count = this.queue.value.length;
    this.queue.value = [];
    this.notifyChanged();
    this.notifyChanged();
    console.log(`[ChatMessageQueue] Cleared ${ count } pending messages`);
  }

  /**
   * Set processing state
   */
  setProcessing(value: boolean): void {
    this.processing.value = value;
  }

  /**
   * Move a message up in the queue
   */
  moveUp(messageId: string): boolean {
    const index = this.queue.value.findIndex(m => m.id === messageId);
    if (index <= 0) return false;

    const temp = this.queue.value[index - 1];
    this.queue.value[index - 1] = this.queue.value[index];
    this.queue.value[index] = temp;
    this.notifyChanged();

    return true;
  }

  /**
   * Move a message down in the queue
   */
  moveDown(messageId: string): boolean {
    const index = this.queue.value.findIndex(m => m.id === messageId);
    if (index === -1 || index >= this.queue.value.length - 1) return false;

    const temp = this.queue.value[index + 1];
    this.queue.value[index + 1] = this.queue.value[index];
    this.queue.value[index] = temp;
    this.notifyChanged();

    return true;
  }

  /** Restore only well-shaped queued sends; an unacknowledged in-flight item is retryable. */
  restore(snapshot: unknown): void {
    if (!Array.isArray(snapshot)) return;
    const restored: QueuedMessage[] = [];
    for (const value of snapshot) {
      if (!value || typeof value !== 'object') continue;
      const candidate = value as Partial<QueuedMessage>;
      if (typeof candidate.id !== 'string' || typeof candidate.content !== 'string'
          || !Array.isArray(candidate.attachments) || typeof candidate.timestamp !== 'number') continue;
      const attachments = candidate.attachments.filter((attachment): attachment is PendingAttachment => !!attachment
        && typeof attachment === 'object'
        && typeof (attachment as PendingAttachment).name === 'string'
        && typeof (attachment as PendingAttachment).mediaType === 'string'
        && typeof (attachment as PendingAttachment).base64 === 'string'
        && typeof (attachment as PendingAttachment).preview === 'string');
      const metadata = candidate.metadata && typeof candidate.metadata === 'object' && !Array.isArray(candidate.metadata)
        ? this.plainMetadata(candidate.metadata) as Record<string, unknown>
        : undefined;
      if (metadata?.deliveryStatus === 'delivering') metadata.deliveryStatus = 'pending';
      restored.push({
        id: candidate.id,
        content: candidate.content,
        attachments,
        metadata: metadata ? markRaw(metadata) : undefined,
        timestamp: candidate.timestamp,
      });
    }
    this.queue.value = restored;
    this.notifyChanged();
  }

  /** Update a durable row without exposing mutable queue objects to callers. */
  updateMetadataBySendId(sendId: string, patch: Record<string, unknown>): boolean {
    const queued = this.queue.value.find(message => message.metadata?.sendId === sendId);
    return queued ? this.updateMetadata(queued, patch) : false;
  }

  updateMetadataById(messageId: string, patch: Record<string, unknown>): boolean {
    const queued = this.queue.value.find(message => message.id === messageId);
    return queued ? this.updateMetadata(queued, patch) : false;
  }

  private updateMetadata(queued: QueuedMessage, patch: Record<string, unknown>): boolean {
    if (!queued) return false;
    queued.metadata = markRaw(this.plainMetadata({ ...queued.metadata, ...patch }) as Record<string, unknown>);
    this.notifyChanged();
    return true;
  }

  private notifyChanged(): void {
    this.onChanged(this.queue.value);
  }
}

// Singleton instance per tab would be created in ChatInterface
export function createMessageQueue(onChanged?: (messages: readonly QueuedMessage[]) => void): ChatMessageQueue {
  return new ChatMessageQueue(onChanged);
}
