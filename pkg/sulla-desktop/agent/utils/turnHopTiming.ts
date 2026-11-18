// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Logging from '@pkg/utils/logging';

type TurnRecord = { receivedAt: number; previousAt: number; marks: string[]; updatedAt: number; messages: number };

/** Bounded, content-free timing accumulator for the AgentNode -> provider hop. */
export class TurnHopTiming {
  private static readonly entries = new Map<string, TurnRecord>();
  private static readonly maxEntries = 500;
  private static readonly ttlMs = 5 * 60_000;

  /** Starts a fresh record for a turn. Replaces any stale record for the thread. Only fresh turns call this. */
  static begin(state: any, receivedAt: number): void {
    try {
      const id = this.threadId(state);
      const now = Date.now();
      const start = Number(receivedAt) || now;
      this.entries.set(id, { receivedAt: start, previousAt: start, marks: [], updatedAt: now, messages: 0 });
      this.prune(now);
    } catch { /* timing must never affect a turn */ }
  }

  /** Appends a mark to the current turn's record. Never creates a record: marks outside a begun turn are dropped. */
  static mark(state: any, name: string, messages?: number): void {
    try {
      const id = this.threadId(state);
      const now = Date.now();
      this.prune(now);
      const record = this.entries.get(id);
      if (!record) return;
      if (record.marks.length < 256) record.marks.push(`${ name }=+${ now - record.receivedAt }ms(${ now - record.previousAt }ms)`);
      record.previousAt = now;
      record.updatedAt = now;
      if (messages !== undefined) record.messages = messages;
    } catch { /* timing must never affect a turn */ }
  }

  static emitProviderStart(state: any, provider: string, messages: number): void {
    try {
      this.mark(state, 'provider.run.start', messages);
      const id = this.threadId(state);
      const record = this.entries.get(id);
      if (record) Logging.perf.log(`[TurnHop] threadId=${ id } provider=${ provider } msgs=${ messages } marks=[${ record.marks.join(', ') }]`);
      this.entries.delete(id);
    } catch { /* logging must never affect a turn */ }
  }

  static firstEvent(state: any, name: 'first.stream' | 'first.text'): void {
    try {
      this.mark(state, name);
      const elapsed = Date.now() - (Number(state?.metadata?.__turnReceivedAt) || Date.now());
      Logging.perf.log(`[TurnHop] threadId=${ this.threadId(state) } event=${ name } elapsedMs=${ elapsed }`);
    } catch { /* timing must never affect a turn */ }
  }

  private static threadId(state: any): string {
    return String(state?.metadata?.threadId || state?.metadata?.convId || 'unknown');
  }

  private static prune(now: number): void {
    for (const [key, value] of this.entries) if (now - value.updatedAt > this.ttlMs) this.entries.delete(key);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}
