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
    private readonly intervalMs = 15_000,
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

  resume(): void {
    if (this.finishing) {
      this.finishing = false;
      this.generation += 1;
    }
    this.start();
  }

  async finish(): Promise<void> {
    if (this.finishing) return;
    const generation = this.generation;
    const threadId = this.threadId;

    this.finishing = true;
    await this.refresh();
    if (generation === this.generation && threadId === this.threadId) this.stop();
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

  private mergeDetail(incoming: AgentConversationDetail): FeedDetail {
    if (!this.detail || this.detail.id !== incoming.id) return { ...incoming, entries: this.append(incoming.entries) };
    const previousIdentity = this.detail.logIdentity;
    const incomingIdentity = incoming.logIdentity;
    const logWasReplaced = previousIdentity !== undefined && incomingIdentity !== undefined && (
      this.availableIdentityFieldChanged(previousIdentity.ino, incomingIdentity.ino, true) ||
      this.availableIdentityFieldChanged(previousIdentity.birthtimeMs, incomingIdentity.birthtimeMs) ||
      incomingIdentity.size < previousIdentity.size
    );

    if (logWasReplaced) return { ...incoming, entries: this.append(incoming.entries) };
    const existing = this.detail.entries;
    const knownOffsets = existing.flatMap(entry => entry.offset === undefined ? [] : [entry.offset]);
    const lastKnownOffset = knownOffsets.length === 0 ? -1 : Math.max(...knownOffsets);
    const additions = incoming.entries.filter(entry => entry.offset === undefined || entry.offset > lastKnownOffset);

    return { ...incoming, logIdentity: incomingIdentity ?? previousIdentity, entries: [...existing, ...this.append(additions)] };
  }

  private availableIdentityFieldChanged(previous: number, incoming: number, zeroIsUnavailable = false): boolean {
    const previousAvailable = Number.isFinite(previous) && (!zeroIsUnavailable || previous !== 0);
    const incomingAvailable = Number.isFinite(incoming) && (!zeroIsUnavailable || incoming !== 0);

    return previousAvailable && incomingAvailable && previous !== incoming;
  }

  private append(entries: ConversationEntry[]): FeedEntry[] {
    return entries.map(entry => ({ ...entry, feedSequence: this.nextSequence++ }));
  }

  private emit(loading: boolean): void {
    this.onChange({ detail: this.detail, loading });
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.visibility.hidden) void this.refresh();
  };
}
