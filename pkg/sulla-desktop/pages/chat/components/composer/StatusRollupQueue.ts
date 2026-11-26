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
  readonly kind?: StatusRollupKind;
  readonly phase?: StatusRollupPhase;
  readonly correlationId?: string;
  readonly text: string;
  /** Unix epoch milliseconds. */
  readonly observedAt: number;
  /** A stable thought-key revision; update an active thought without replaying an expired one. */
  readonly updateOnly?: boolean;
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

/**
 * Sanitizes and remembers status events. Despite the historical class name,
 * this deliberately has no queue or replay policy: each observation selects
 * the newest unseen live item and remembers it for the life of this instance.
 */
export class StatusRollupQueue {
  static readonly historyLimit = 6;
  private static readonly textLimit = 180;
  private static readonly labelLimit = 80;

  private threadId = '';
  private currentItem: StatusRollupItem | null = null;
  private historyItems: StatusRollupItem[] = [];
  private readonly seenKeysByThread = new Map<string, Set<string>>();

  get current(): StatusRollupItem | null {
    return this.currentItem;
  }

  get history(): readonly StatusRollupItem[] {
    return [...this.historyItems];
  }

  /** Prime source rows visible at setup without rendering or adding history. */
  prime(items: readonly StatusRollupItem[], threadId: string): void {
    for (const item of items) {
      if (item.threadId === threadId && item.key) this.rememberKey(threadId, item.key);
    }
  }

  reset(threadId: string): void {
    this.threadId = threadId;
    this.currentItem = null;
    this.historyItems = [];
  }

  /** Sanitize a source event and reject empty, malformed, or foreign-thread rows. */
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
      ...(item.updateOnly ? { updateOnly: true } : {}),
      urgency: this.normalizeUrgency(item.urgency),
      role: this.normalizeRole(item.role),
    };
  }

  /**
   * Accept only items newer than the subscription boundary. A batch is never
   * drained: all new events are remembered for recent-history, while only its
   * latest event is returned for immediate display.
   */
  observe(
    items: readonly StatusRollupItem[],
    threadId: string,
    now: number,
    newerThan: number,
  ): StatusRollupItem | null {
    if (!threadId) return null;
    if (threadId !== this.threadId) this.reset(threadId);
    const seen = this.seenKeys(threadId);
    const ordered = [...items].filter(item => item.threadId === threadId)
      .sort((left, right) => left.observedAt - right.observedAt);
    let newest: StatusRollupItem | null = null;

    for (const source of ordered) {
      const item = this.present(source, threadId, now);
      if (!item || item.observedAt <= newerThan) continue;
      if (seen.has(item.key)) {
        if (item.updateOnly && this.currentItem?.key === item.key) {
          this.currentItem = item;
          newest = item;
        }
        continue;
      }

      this.rememberKey(threadId, item.key);
      this.historyItems.unshift(item);
      this.historyItems = this.historyItems.slice(0, StatusRollupQueue.historyLimit);
      newest = item;
    }

    if (newest) this.currentItem = newest;
    return newest;
  }

  /** Records a status once it has actually made it to the line. */
  markShown(item: StatusRollupItem): void {
    this.rememberKey(item.threadId, item.key);
    this.currentItem = item;
  }

  clearCurrent(key: string): void {
    if (this.currentItem?.key === key) this.currentItem = null;
  }

  private seenKeys(threadId: string): Set<string> {
    let keys = this.seenKeysByThread.get(threadId);
    if (!keys) {
      keys = new Set<string>();
      this.seenKeysByThread.set(threadId, keys);
    }
    return keys;
  }

  private rememberKey(threadId: string, key: string): void {
    const keys = this.seenKeys(threadId);
    keys.add(key);
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
