// ChatMessageQueue.ts — Message queue for sequential processing with Windsurf-style UX
import { ref, computed } from 'vue';
import type { PendingAttachment } from '../pages/agent/AgentComposer.vue';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments: PendingAttachment[];
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export class ChatMessageQueue {
  private readonly queue = ref<QueuedMessage[]>([]);
  private processing = ref(false);

  readonly pendingMessages = computed(() => this.queue.value);
  readonly hasPendingMessages = computed(() => this.queue.value.length > 0);
  readonly isProcessing = computed(() => this.processing.value);
  readonly queueLength = computed(() => this.queue.value.length);

  /**
   * Add a message to the queue
   */
  enqueue(content: string, attachments: PendingAttachment[] = [], metadata?: Record<string, unknown>): QueuedMessage {
    const message: QueuedMessage = {
      id: `queued_${ Date.now() }_${ Math.random().toString(36).slice(2, 8) }`,
      content,
      attachments,
      metadata,
      timestamp: Date.now(),
    };

    this.queue.value.push(message);
    console.log(`[ChatMessageQueue] Enqueued message #${ this.queue.value.length }: ${ content.slice(0, 50) }...`);

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
    console.log(`[ChatMessageQueue] Dequeued message: ${ removed.content.slice(0, 50) }...`);

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
    console.log(`[ChatMessageQueue] Processing message: ${ message.content.slice(0, 50) }...`);

    return message;
  }

  /**
   * Clear all pending messages
   */
  clear(): void {
    const count = this.queue.value.length;
    this.queue.value = [];
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

    return true;
  }
}

// Singleton instance per tab would be created in ChatInterface
export function createMessageQueue(): ChatMessageQueue {
  return new ChatMessageQueue();
}
