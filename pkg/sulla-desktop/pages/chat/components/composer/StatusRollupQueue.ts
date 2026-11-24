/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

export type StatusRollupUrgency = 'normal' | 'needs-you' | 'failed';
export type StatusRollupAgentRole = 'root' | 'manager' | 'worker' | 'reviewer';

/** A plain-text, already thread-scoped check-in supplied by the chat presenter. */
export interface StatusRollupItem {
  readonly key: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly lane?: string;
  readonly text: string;
  /** Unix epoch milliseconds. */
  readonly observedAt: number;
  readonly urgency?: StatusRollupUrgency;
  readonly role?: StatusRollupAgentRole;
}

export interface StatusRollupShownEvent {
  readonly key: string;
  readonly agentId: string;
  readonly threadId: string;
}

interface QueuedStatusRollupItem {
  readonly item: StatusRollupItem;
  readonly sequence: number;
}

interface VisibleStatusRollupItem {
  readonly item: StatusRollupItem;
  readonly replaceableAt: number;
}

/**
 * Bounded status-snippet scheduler. Time is supplied by callers so queue policy
 * can be verified deterministically without timers or a browser environment.
 */
export class StatusRollupQueue {
  static readonly capacity = 5;
  static readonly minGapMs = 1_000;
  static readonly nonUrgentExpiryMs = 6_000;
  static readonly normalHoldMs = 750;
  static readonly urgentHoldMs = 2_600;
  static readonly historyLimit = 6;
  private static readonly processedKeyLimit = 256;
  private static readonly textLimit = 180;
  private static readonly labelLimit = 80;

  private threadId = '';
  private queued: QueuedStatusRollupItem[] = [];
  private visible: VisibleStatusRollupItem | null = null;
  private lastShownAt: number | null = null;
  private sequence = 0;
  private historyItems: StatusRollupItem[] = [];
  private processedKeys: string[] = [];
  private processedKeySet = new Set<string>();

  get current(): StatusRollupItem | null {
    return this.visible?.item ?? null;
  }

  get history(): readonly StatusRollupItem[] {
    return [...this.historyItems];
  }

  get pending(): readonly StatusRollupItem[] {
    return this.queued.map(entry => entry.item);
  }

  reset(threadId: string): void {
    this.threadId = threadId;
    this.queued = [];
    this.visible = null;
    this.lastShownAt = null;
    this.sequence = 0;
    this.historyItems = [];
    this.processedKeys = [];
    this.processedKeySet.clear();
  }

  /** Sanitizes input for text-only rendering, rejecting items from other chats. */
  present(item: StatusRollupItem | null | undefined, threadId: string, now: number): StatusRollupItem | null {
    if (!item || !threadId || item.threadId !== threadId || !item.key || !item.agentId) return null;
    const agentName = this.cleanLabel(item.agentName);
    const text = this.cleanText(item.text);
    if (!agentName || !text) return null;

    return {
      key: item.key,
      threadId,
      agentId: item.agentId,
      agentName,
      ...(item.lane ? { lane: this.cleanLabel(item.lane) } : {}),
      text,
      observedAt: Number.isFinite(item.observedAt) ? item.observedAt : now,
      urgency: this.normalizeUrgency(item.urgency),
      role: this.normalizeRole(item.role),
    };
  }

  /**
   * Tracks unique observed check-ins and queues eligible snippets. If all five
   * slots are urgent, new arrivals are dropped; urgent overflow drops the newest
   * urgent arrival to preserve FIFO.
   */
  observe(
    items: readonly StatusRollupItem[],
    threadId: string,
    now: number,
    displayedItem: StatusRollupItem | null = null,
  ): void {
    if (threadId !== this.threadId) this.reset(threadId);
    this.expireQueued(now);

    const ordered = [...items]
      .filter(item => item.threadId === threadId)
      .sort((left, right) => left.observedAt - right.observedAt);

    for (const source of ordered) {
      if (this.processedKeySet.has(source.key)) continue;
      const item = this.present(source, threadId, now);
      if (!item) continue;

      this.rememberProcessedKey(item.key);
      this.historyItems.unshift(item);
      this.historyItems = this.historyItems.slice(0, StatusRollupQueue.historyLimit);

      const shown = this.visible?.item ?? displayedItem;
      if (shown && this.sameVisibleSnippet(shown, item)) continue;
      if (item.urgency === 'normal' && now - item.observedAt > StatusRollupQueue.nonUrgentExpiryMs) continue;

      this.queued = this.queued.filter(entry => entry.item.agentId !== item.agentId);
      if (!this.makeRoomFor()) continue;

      this.queued.push({ item, sequence: ++this.sequence });
    }
  }

  /** Seeds an idle/thread-switched roll-up from its newest scoped check-in, regardless of age. */
  seed(items: readonly StatusRollupItem[], threadId: string, now: number): StatusRollupItem | null {
    if (this.visible || !threadId) return this.current;
    const newest = [...items]
      .filter(item => item.threadId === threadId)
      .sort((left, right) => right.observedAt - left.observedAt)[0];
    const item = this.present(newest, threadId, now);
    if (!item) return null;
    this.queued = this.queued.filter(entry => entry.item.key !== item.key);
    const holdMs = this.isUrgent(item) ? StatusRollupQueue.urgentHoldMs : StatusRollupQueue.normalHoldMs;
    this.visible = { item, replaceableAt: now + holdMs };
    this.lastShownAt = now;
    return item;
  }

  /**
   * Advances the queue by fakeable epoch time. The displayed item persists;
   * its hold only gates replacement, and pausing freezes replacement.
   */
  pump(now: number, paused = false): StatusRollupItem | null {
    this.expireQueued(now);
    if (paused) return null;
    if (this.visible && now < this.visible.replaceableAt) return null;
    if (this.queued.length === 0) return null;
    if (this.lastShownAt !== null && now - this.lastShownAt < StatusRollupQueue.minGapMs) return null;

    const urgentIndex = this.queued.findIndex(entry => this.isUrgent(entry.item));
    const next = this.queued.splice(urgentIndex >= 0 ? urgentIndex : 0, 1)[0];
    if (!next) return null;

    const holdMs = this.isUrgent(next.item) ? StatusRollupQueue.urgentHoldMs : StatusRollupQueue.normalHoldMs;
    this.visible = { item: next.item, replaceableAt: now + holdMs };
    this.lastShownAt = now;
    return next.item;
  }

  private expireQueued(now: number): void {
    this.queued = this.queued.filter(entry =>
      this.isUrgent(entry.item) || now - entry.item.observedAt <= StatusRollupQueue.nonUrgentExpiryMs,
    );
  }

  private makeRoomFor(): boolean {
    if (this.queued.length < StatusRollupQueue.capacity) return true;

    // Evict the oldest nonurgent item first, regardless of the arriving item's priority.
    let oldestNonUrgentIndex = -1;
    let oldestSequence = Number.POSITIVE_INFINITY;
    this.queued.forEach((entry, index) => {
      if (!this.isUrgent(entry.item) && entry.sequence < oldestSequence) {
        oldestSequence = entry.sequence;
        oldestNonUrgentIndex = index;
      }
    });

    if (oldestNonUrgentIndex >= 0) {
      this.queued.splice(oldestNonUrgentIndex, 1);
      return true;
    }

    // All existing slots are urgent. Keep the queue bounded and preserve urgent FIFO.
    return false;
  }

  private sameVisibleSnippet(left: StatusRollupItem, right: StatusRollupItem): boolean {
    return left.agentId === right.agentId && this.cleanText(left.text) === this.cleanText(right.text);
  }

  private isUrgent(item: StatusRollupItem): boolean {
    return item.urgency === 'needs-you' || item.urgency === 'failed';
  }

  private rememberProcessedKey(key: string): void {
    this.processedKeys.push(key);
    this.processedKeySet.add(key);
    if (this.processedKeys.length <= StatusRollupQueue.processedKeyLimit) return;
    const oldest = this.processedKeys.shift();
    if (oldest) this.processedKeySet.delete(oldest);
  }

  private cleanText(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, StatusRollupQueue.textLimit);
  }

  private cleanLabel(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, StatusRollupQueue.labelLimit);
  }

  private normalizeUrgency(value: StatusRollupUrgency | undefined): StatusRollupUrgency {
    return value === 'needs-you' || value === 'failed' ? value : 'normal';
  }

  private normalizeRole(value: StatusRollupAgentRole | undefined): StatusRollupAgentRole {
    return value === 'root' || value === 'manager' || value === 'reviewer' ? value : 'worker';
  }
}
