// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { RelayPayloadCodec } from './RelayPayloadCodec.js';
import { MAX_EVENT_BYTES, MAX_QUEUE_EVENTS } from './RelayLimits.js';

import type { VaultRelayEvent } from './RelayContracts.js';

export class RelayEventQueue {
  private readonly queue: VaultRelayEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private nextSequence = 1;

  constructor(
    private readonly sensitiveValues: () => Iterable<string>,
    private readonly maxEventBytes = MAX_EVENT_BYTES,
  ) {}

  push(type: string, payload: unknown): number {
    if (this.closed) return 0;
    const safePayload = RelayPayloadCodec.sanitized(payload, this.sensitiveValues());
    if (RelayPayloadCodec.jsonBytes(safePayload) > this.maxEventBytes) throw new Error('relay_event_too_large');
    if (this.queue.length >= MAX_QUEUE_EVENTS) {
      this.queue.length = 0;
      this.queue.push({
        sequence: this.nextSequence++,
        type:     'relay.gap',
        payload:  { reason: 'queue_overflow' },
      });
    }
    const sequence = this.nextSequence++;
    this.queue.push({ sequence, type, payload: safePayload });
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    return sequence;
  }

  /** `drain` keeps already-queued events readable (graceful upstream close). */
  end(drain = false): void {
    this.closed = true;
    if (!drain) this.queue.length = 0;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  async * iterate(signal: AbortSignal): AsyncIterable<VaultRelayEvent> {
    while (!signal.aborted) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>(resolve => {
        const wake = () => {
          signal.removeEventListener('abort', wake);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
  }
}
