// Typed event bus for ChatController → subscriber communication.
// Used for telemetry, tests, and cross-cutting reactions that shouldn't
// live inside the controller itself.

import type { MessageId, ArtifactId, ThreadId } from '../types/chat';
import type { Message } from '../models/Message';
import type { RunState } from '../models/RunState';

export type ChatEvent =
  | { kind: 'messageAppended';    threadId: ThreadId; message: Message }
  | { kind: 'messageUpdated';     threadId: ThreadId; messageId: MessageId; patch: Partial<Message> }
  | { kind: 'messageRemoved';     threadId: ThreadId; messageId: MessageId }
  | { kind: 'runStateChanged';    threadId: ThreadId; from: RunState; to: RunState }
  | { kind: 'artifactOpened';     threadId: ThreadId; artifactId: ArtifactId }
  | { kind: 'artifactClosed';     threadId: ThreadId; artifactId: ArtifactId }
  | { kind: 'voiceStarted';       threadId: ThreadId }
  | { kind: 'voiceStopped';       threadId: ThreadId; committed: boolean }
  | { kind: 'ttsStarted';         threadId: ThreadId; messageId: MessageId }
  | { kind: 'ttsStopped';         threadId: ThreadId; messageId: MessageId }
  | { kind: 'modelSwitched';      threadId: ThreadId; modelId: string }
  | { kind: 'connectionChanged';  threadId: ThreadId; state: 'online' | 'degraded' | 'offline' }
  | { kind: 'titleChanged';       threadId: ThreadId; title: string }
  | { kind: 'memorySaved';        threadId: ThreadId; memoryId: string }
  | { kind: 'patchApplied';       threadId: ThreadId; messageId: MessageId }
  | { kind: 'toolApprovalResolved'; threadId: ThreadId; messageId: MessageId; approvalId: string; decision: 'approved' | 'denied'; note?: string }
  | { kind: 'threadHydrated';     threadId: ThreadId }
  | { kind: 'threadSerialized';   threadId: ThreadId };

export type Unsubscribe = () => void;

export class EventBus<E extends { kind: string }> {
  private handlers = new Map<E['kind'], Set<(e: E) => void>>();

  emit(event: E): void {
    const set = this.handlers.get(event.kind as E['kind']);
    if (!set) return;
    for (const h of set) {
      try { h(event); } catch (err) { console.error('[EventBus] handler threw:', err); }
    }
  }

  on<K extends E['kind']>(kind: K, handler: (e: Extract<E, { kind: K }>) => void): Unsubscribe {
    let set = this.handlers.get(kind as E['kind']);
    if (!set) { set = new Set(); this.handlers.set(kind as E['kind'], set); }
    set.add(handler as (e: E) => void);
    return () => { set?.delete(handler as (e: E) => void); };
  }

  clear(): void {
    this.handlers.clear();
  }
}
