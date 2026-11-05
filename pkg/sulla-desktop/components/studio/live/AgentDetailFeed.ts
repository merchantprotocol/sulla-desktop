// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentConversationDetail } from '@pkg/main/agentsIpc';

type ConversationEntry = AgentConversationDetail['entries'][number];
export type FeedEntry = ConversationEntry & { readonly feedSequence: number };
export type FeedDetail = Omit<AgentConversationDetail, 'entries'> & { entries: FeedEntry[] };
type IpcInvoker = (channel: string, ...args: unknown[]) => Promise<unknown>;
type TimerHandle = ReturnType<typeof setInterval>;

export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface FeedSnapshot {
  detail: FeedDetail | null;
  loading: boolean;
}

export class AgentDetailFeed {
  private threadId: string | null = null;
  private detail: FeedDetail | null = null;
  private firstLoad = true;
  private timer: TimerHandle | undefined;
  private generation = 0;
  private nextSequence = 1;
  private finishing = false;

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
    this.nextSequence = 1;
    this.finishing = false;
    this.generation += 1;
    this.emit(false);
    if (this.threadId) this.start();
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

  async finish(): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    await this.refresh();
    this.stop();
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

    if (entryWithId.id) return `id:${ entryWithId.id }`;
    return JSON.stringify([entry.ts, entry.kind, entry.toolName ?? '', entry.text]);
  }

  private mergeDetail(incoming: AgentConversationDetail): FeedDetail {
    if (!this.detail || this.detail.id !== incoming.id) return { ...incoming, entries: this.append(incoming.entries) };
    const existing = this.detail.entries;
    const incomingKeys = incoming.entries.map(AgentDetailFeed.entryKey);
    const existingKeys = existing.map(AgentDetailFeed.entryKey);

    // A shorter reread may be any unchanged slice of the capped tail.
    if (this.containsOrdered(existingKeys, incomingKeys)) return { ...incoming, entries: existing };

    let overlap = Math.min(existingKeys.length, incomingKeys.length);

    while (overlap > 0 && !this.sameKeys(existingKeys.slice(-overlap), incomingKeys.slice(0, overlap))) overlap -= 1;

    // With no overlap the source window reset or shifted beyond our retained history.
    // Appending all incoming rows preserves readable history without losing multiplicity.
    return { ...incoming, entries: [...existing, ...this.append(incoming.entries.slice(overlap))] };
  }

  private append(entries: ConversationEntry[]): FeedEntry[] {
    return entries.map(entry => ({ ...entry, feedSequence: this.nextSequence++ }));
  }

  private containsOrdered(existing: string[], incoming: string[]): boolean {
    if (incoming.length === 0) return true;
    for (let start = 0; start <= existing.length - incoming.length; start += 1) {
      if (this.sameKeys(existing.slice(start, start + incoming.length), incoming)) return true;
    }
    return false;
  }

  private sameKeys(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((key, index) => key === right[index]);
  }

  private emit(loading: boolean): void {
    this.onChange({ detail: this.detail, loading });
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.visibility.hidden) void this.refresh();
  };
}
