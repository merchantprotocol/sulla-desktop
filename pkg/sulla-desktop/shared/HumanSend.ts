// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type HumanSendRoute = 'steer' | 'new_turn' | 'idle';
export type HumanSendPath = 'injected' | 'queued' | 'sent_fresh';

/** Renderer → backend correlation metadata for one human message. */
export interface HumanSendDispatch {
  sendId: string;
  /** Additional fragment ids represented by one coalesced voice turn. */
  coalescedSendIds?: string[];
  route: HumanSendRoute;
  enqueuedAtMs: number;
  path?: HumanSendPath;
}

export interface HumanSendReceipt extends HumanSendDispatch {
  status: 'accepted' | 'cancelled' | 'rejected';
}

export function newHumanSendId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? `hs_${ randomId }` : `hs_${ Date.now().toString(36) }_${ Math.random().toString(36).slice(2, 10) }`;
}

/** Content-free wait measurements shared by renderer and backend log sinks. */
export class HumanSendWaitRecorder {
  constructor(
    private readonly write: (line: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  enqueued(send: HumanSendDispatch, threadId: string): void {
    this.write(`[HumanSendWait] phase=enqueued sendId=${ this.safeId(send.sendId) } threadId=${ this.safeId(threadId) } route=${ send.route } path=${ send.path ?? 'sent_fresh' } tMs=${ this.safeTime(send.enqueuedAtMs) } dwellMs=0`);
  }

  accepted(send: HumanSendDispatch, threadId: string): void {
    const tMs = this.now();
    this.write(`[HumanSendWait] phase=accepted sendId=${ this.safeId(send.sendId) } threadId=${ this.safeId(threadId) } route=${ send.route } path=${ send.path ?? 'sent_fresh' } tMs=${ tMs } dwellMs=${ Math.max(0, tMs - this.safeTime(send.enqueuedAtMs)) }`);
  }

  private safeId(value: string): string {
    return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : 'invalid';
  }

  private safeTime(value: number): number {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }
}
