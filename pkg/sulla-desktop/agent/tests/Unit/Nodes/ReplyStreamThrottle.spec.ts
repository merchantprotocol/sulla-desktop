// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ReplyStreamThrottle, type ReplyStreamClock } from '../../../nodes/ReplyStreamThrottle';

/** Deterministic clock: timers fire only when the test advances time. */
class ManualClock implements ReplyStreamClock {
  private time = 1_000;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; handler: () => void }>();

  now(): number { return this.time }

  setTimeout(handler: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, handler });

    return id;
  }

  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].handler();
    }
    this.time = end;
  }
}

const INTERVAL = 50;

describe('ReplyStreamThrottle', () => {
  it('publishes the latest reply text within one interval of the last token, never faster than the interval', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ gap: fc.integer({ min: 0, max: 200 }), token: fc.string({ minLength: 1, maxLength: 4 }) }), { minLength: 1, maxLength: 60 }),
      (tokens) => {
        const clock = new ManualClock();
        let buffer = '';
        const published: { at: number; text: string }[] = [];
        const throttle = new ReplyStreamThrottle(() => published.push({ at: clock.now(), text: buffer }) > 0, INTERVAL, clock);

        for (const { gap, token } of tokens) {
          clock.advance(gap);
          buffer += token;
          throttle.changed();
        }
        // No further tokens: e.g. the model moved on to a long tool call.
        clock.advance(INTERVAL);

        expect(published.at(-1)?.text).toBe(buffer);
        for (let i = 1; i < published.length; i++) expect(published[i].at - published[i - 1].at).toBeGreaterThanOrEqual(INTERVAL);
      },
    ));
  });

  it('publishes the first token at once', () => {
    const clock = new ManualClock();
    const published: number[] = [];
    new ReplyStreamThrottle(() => published.push(clock.now()) > 0, INTERVAL, clock).changed();

    expect(published).toEqual([clock.now()]);
  });

  it('ignores every change once the stream has stopped', () => {
    const clock = new ManualClock();
    let count = 0;
    const throttle = new ReplyStreamThrottle(() => ++count > 0, INTERVAL, clock);
    throttle.changed();
    throttle.changed();
    throttle.stop();
    throttle.changed();
    clock.advance(INTERVAL * 4);

    expect(count).toBe(1);
  });

  it('publishes the first visible change at once when earlier changes had nothing to show', () => {
    const clock = new ManualClock();
    let visible = false;
    const published: number[] = [];
    const throttle = new ReplyStreamThrottle(() => visible && published.push(clock.now()) > 0, INTERVAL, clock);
    throttle.changed(); // e.g. a paragraph break before any words
    clock.advance(5);
    visible = true;
    throttle.changed();

    expect(published).toEqual([clock.now()]);
  });

  it('starts a fresh window after a reset', () => {
    const clock = new ManualClock();
    const published: number[] = [];
    const throttle = new ReplyStreamThrottle(() => published.push(clock.now()) > 0, INTERVAL, clock);
    throttle.changed();
    clock.advance(5);
    throttle.reset(); // the caller closed the segment itself
    throttle.changed();

    expect(published).toEqual([clock.now() - 5, clock.now()]);
  });
});
