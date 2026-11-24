// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ReplyStreamClock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: ReplyStreamClock = {
  now:          () => Date.now(),
  setTimeout:   (handler, ms) => setTimeout(handler, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Rate-limits live reply updates without losing the tail of a burst.
 *
 * The first change publishes at once. Changes inside the window are held and
 * published when the window ends, so the latest text always reaches the chat
 * within `intervalMs`, even if no further token arrives for minutes.
 */
export class ReplyStreamThrottle {
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  private pending: unknown;
  private stopped = false;

  /** `publish` returns false when it had nothing to show, which leaves the window open. */
  constructor(
    private readonly publish: () => boolean,
    private readonly intervalMs: number,
    private readonly clock: ReplyStreamClock = systemClock,
  ) {}

  /** Note that the reply changed; publishes now or by the end of the current window. */
  changed(): void {
    if (this.stopped || this.pending !== undefined) return;
    const wait = this.lastPublishAt + this.intervalMs - this.clock.now();
    if (wait <= 0) {
      this.run();
      return;
    }
    this.pending = this.clock.setTimeout(() => this.run(), wait);
  }

  /**
   * Drop a held update and start a fresh window: the caller published or
   * discarded the text itself, so the next segment's first change goes out at once.
   */
  reset(): void {
    if (this.pending !== undefined) this.clock.clearTimeout(this.pending);
    this.pending = undefined;
    this.lastPublishAt = Number.NEGATIVE_INFINITY;
  }

  /** End of the stream: drop any held update and ignore later changes. */
  stop(): void {
    this.reset();
    this.stopped = true;
  }

  private run(): void {
    this.pending = undefined;
    if (this.publish()) this.lastPublishAt = this.clock.now();
  }
}
