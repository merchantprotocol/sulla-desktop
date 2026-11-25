/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

export type StatusRollupUrgency = 'normal' | 'needs-you' | 'failed';
export type StatusRollupAgentRole = 'root' | 'manager' | 'worker' | 'reviewer';
export type StatusRollupKind = 'read' | 'edit' | 'run' | 'agent' | 'status' | 'thought' | 'reply' | 'tool';
export type StatusRollupPhase = 'start' | 'result';

/** A plain-text, already thread-scoped check-in supplied by the chat presenter. */
export interface StatusRollupItem {
  readonly key: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly lane?: string;
  /** Short action label shown between the agent name and the activity text. */
  readonly kind?: StatusRollupKind;
  /** Start/result pairing for glow depth tracking; never used as rendered content. */
  readonly phase?: StatusRollupPhase;
  readonly correlationId?: string;
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
  readonly role?: StatusRollupAgentRole;
  readonly kind?: StatusRollupKind;
  readonly phase?: StatusRollupPhase;
  readonly correlationId?: string;
}

interface QueuedStatusRollupItem {
  readonly item: StatusRollupItem;
  readonly sequence: number;
}

interface VisibleStatusRollupItem {
  readonly item: StatusRollupItem;
  readonly holdUntil: number;
}

/**
 * Bounded status-snippet scheduler. Time is supplied by callers so queue policy
 * can be verified deterministically without timers or a browser environment.
 */
export class StatusRollupQueue {
  static readonly quietGapMs = 1_200;
  static readonly busyGapMs = 250;
  static readonly maximumDrainMs = 3_000;
  static readonly urgentHoldMs = 2_600;
  static readonly historyLimit = 6;
  private static readonly textLimit = 180;
  private static readonly labelLimit = 80;

  private threadId = '';
  private queued: QueuedStatusRollupItem[] = [];
  private visible: VisibleStatusRollupItem | null = null;
  private lastShownAt: number | null = null;
  private burstGapMs: number | null = null;
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
    this.burstGapMs = null;
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
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.phase ? { phase: item.phase } : {}),
      ...(item.correlationId ? { correlationId: item.correlationId } : {}),
      text,
      observedAt: Number.isFinite(item.observedAt) ? item.observedAt : now,
      urgency: this.normalizeUrgency(item.urgency),
      role: this.normalizeRole(item.role),
    };
  }

  /**
   * Tracks unique observed events and queues every eligible item. The queue is
   * intentionally lossless: only repeated stable keys are collapsed.
   */
  observe(
    items: readonly StatusRollupItem[],
    threadId: string,
    now: number,
    displayedItem: StatusRollupItem | null = null,
  ): void {
    if (threadId !== this.threadId) this.reset(threadId);
    const startingLength = this.queued.length;
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
      if (shown?.key === item.key) continue;
      this.queued.push({ item, sequence: ++this.sequence });
    }
    const added = this.queued.length - startingLength;
    if (added > 0 && this.queued.length > 1) {
      const paceForBurst = Math.min(StatusRollupQueue.busyGapMs,
        StatusRollupQueue.maximumDrainMs / this.queued.length);
      this.burstGapMs = Math.min(this.burstGapMs ?? paceForBurst, paceForBurst);
    }
  }

  /** Seeds an idle/thread-switched roll-up from its newest scoped check-in, regardless of age. */
  seed(items: readonly StatusRollupItem[], threadId: string, now: number): StatusRollupItem | null {
    // A single initial item can render during setup/SSR; with a real backlog,
    // keep FIFO playback intact instead of jumping to the newest event.
    if (this.visible || !threadId || this.queued.length > 1) return this.current;
    const newest = [...items]
      .filter(item => item.threadId === threadId)
      .sort((left, right) => right.observedAt - left.observedAt)[0];
    const item = this.present(newest, threadId, now);
    if (!item) return null;
    this.queued = this.queued.filter(entry => entry.item.key !== item.key);
    const holdMs = this.isUrgent(item) ? StatusRollupQueue.urgentHoldMs : 0;
    this.visible = { item, holdUntil: now + holdMs };
    this.lastShownAt = now;
    return item;
  }

  /**
   * Advances the queue by fakeable epoch time. Quiet updates have a relaxed
   * cadence; a burst drains at a pace calculated to fit in roughly three seconds.
   * Urgent items jump ahead of normal work and keep their full reading hold.
   */
  pump(now: number, paused = false): StatusRollupItem | null {
    if (paused) return null;
    if (this.queued.length === 0) return null;
    const urgentIndex = this.queued.findIndex(entry => this.isUrgent(entry.item));
    const currentUrgent = this.visible && this.isUrgent(this.visible.item);
    if (currentUrgent && now < this.visible!.holdUntil) return null;
    if (urgentIndex < 0 && this.lastShownAt !== null && now - this.lastShownAt < (this.burstGapMs ?? StatusRollupQueue.quietGapMs)) return null;

    const next = this.queued.splice(urgentIndex >= 0 ? urgentIndex : 0, 1)[0];
    if (!next) return null;

    const holdMs = this.isUrgent(next.item) ? StatusRollupQueue.urgentHoldMs : 0;
    this.visible = { item: next.item, holdUntil: now + holdMs };
    this.lastShownAt = now;
    if (this.queued.length === 0) this.burstGapMs = null;
    return next.item;
  }

  private isUrgent(item: StatusRollupItem): boolean {
    return item.urgency === 'needs-you' || item.urgency === 'failed';
  }

  private rememberProcessedKey(key: string): void {
    if (this.processedKeySet.has(key)) return;
    this.processedKeys.push(key);
    this.processedKeySet.add(key);
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
