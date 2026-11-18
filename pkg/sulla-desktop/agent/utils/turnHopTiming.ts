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

  static mark(state: any, name: string, messages?: number): void {
    try {
      const metadata = state?.metadata;
      const id = String(metadata?.threadId || metadata?.convId || 'unknown');
      const now = Date.now();
      this.prune(now);
      let record = this.entries.get(id);
      if (!record) {
        const receivedAt = Number(metadata?.__turnReceivedAt) || now;
        record = { receivedAt, previousAt: receivedAt, marks: [], updatedAt: now, messages: Number(messages) || 0 };
        this.entries.set(id, record);
      }
      if (record.marks.length < 256) record.marks.push(`${ name }=+${ now - record.receivedAt }ms(${ now - record.previousAt }ms)`);
      record.previousAt = now;
      record.updatedAt = now;
      if (messages !== undefined) record.messages = messages;
    } catch { /* timing must never affect a turn */ }
  }

  static emitProviderStart(state: any, provider: string, messages: number): void {
    try {
      this.mark(state, 'provider.run.start', messages);
      const id = String(state?.metadata?.threadId || state?.metadata?.convId || 'unknown');
      const record = this.entries.get(id);
      if (record) Logging.perf.log(`[TurnHop] threadId=${ id } provider=${ provider } msgs=${ messages } marks=[${ record.marks.join(', ') }]`);
      this.entries.delete(id);
    } catch { /* logging must never affect a turn */ }
  }

  static firstEvent(state: any, name: 'first.stream' | 'first.text'): void {
    try {
      this.mark(state, name);
      const elapsed = Date.now() - (Number(state?.metadata?.__turnReceivedAt) || Date.now());
      Logging.perf.log(`[TurnHop] threadId=${ state?.metadata?.threadId || state?.metadata?.convId || 'unknown' } event=${ name } elapsedMs=${ elapsed }`);
    } catch { /* timing must never affect a turn */ }
  }

  private static prune(now: number): void {
    for (const [key, value] of this.entries) if (now - value.updatedAt > this.ttlMs) this.entries.delete(key);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}
