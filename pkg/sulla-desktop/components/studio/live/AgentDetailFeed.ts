// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentConversationDetail } from '@pkg/main/agentsIpc';

type ConversationEntry = AgentConversationDetail['entries'][number];
type IpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;
type TimerHandle = ReturnType<typeof setInterval>;

export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface FeedSnapshot {
  detail: AgentConversationDetail | null;
  loading: boolean;
}

export class AgentDetailFeed {
  private threadId: string | null = null;
  private detail: AgentConversationDetail | null = null;
  private firstLoad = true;
  private timer: TimerHandle | undefined;
  private generation = 0;

  constructor(
    private readonly invoke: IpcInvoker,
    private readonly visibility: VisibilitySource,
    private readonly setTimer: (callback: () => void, milliseconds: number) => TimerHandle,
    private readonly clearTimer: (handle: TimerHandle) => void,
    private readonly onChange: (snapshot: FeedSnapshot) => void,
    private readonly intervalMs = 3_000,
  ) {}

  select(threadId?: string): void {
    const nextThreadId = threadId ?? null;

    if (nextThreadId === this.threadId) return;
    this.threadId = nextThreadId;
    this.detail = null;
    this.firstLoad = true;
    this.generation += 1;
    this.emit(false);
    if (this.threadId && !this.visibility.hidden) void this.refresh();
  }

  start(): void {
    if (this.timer) return;
    this.visibility.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.timer = this.setTimer(() => {
      if (!this.visibility.hidden) void this.refresh();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    this.visibility.removeEventListener('visibilitychange', this.handleVisibilityChange);
  }

  dispose(): void {
    this.stop();
    this.threadId = null;
    this.detail = null;
    this.generation += 1;
  }

  async refresh(): Promise<void> {
    const threadId = this.threadId;

    if (!threadId || this.visibility.hidden) return;
    const generation = this.generation;
    const showLoading = this.firstLoad;

    if (showLoading) this.emit(true);
    try {
      const incoming = await this.invoke('agents:conversation', threadId) as AgentConversationDetail;

      if (generation !== this.generation || threadId !== this.threadId) return;
      this.detail = this.mergeDetail(incoming);
      this.firstLoad = false;
      this.emit(false);
    } catch {
      if (generation !== this.generation || threadId !== this.threadId) return;
      if (showLoading) this.detail = null;
      this.firstLoad = false;
      this.emit(false);
    }
  }

  static entryKey(entry: ConversationEntry): string {
    const entryWithId = entry as ConversationEntry & { id?: string };

    if (entryWithId.id) return entryWithId.id;
    const value = `${ entry.ts }\u0000${ entry.kind }\u0000${ entry.toolName ?? '' }\u0000${ entry.text }`;
    let hash = 2166136261;

    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return `${ entry.ts }:${ entry.kind }:${ entry.toolName ?? '' }:${ (hash >>> 0).toString(36) }`;
  }

  private mergeDetail(incoming: AgentConversationDetail): AgentConversationDetail {
    if (!this.detail || this.detail.id !== incoming.id) return { ...incoming, entries: [...incoming.entries] };
    const known = new Set(this.detail.entries.map(AgentDetailFeed.entryKey));
    const additions = incoming.entries.filter(entry => !known.has(AgentDetailFeed.entryKey(entry)));

    return { ...incoming, entries: [...this.detail.entries, ...additions] };
  }

  private emit(loading: boolean): void {
    this.onChange({ detail: this.detail, loading });
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.visibility.hidden) void this.refresh();
  };
}
