// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// The Capsule composer's breathing glow (approved mockup: chat-composer-ui-directions.html,
// option "2 · Capsule"). This class only decides WHAT the glow shows; Composer.vue turns
// the state into classes on .composer-capsule and composer-field CSS animates opacity and
// transform of the pre-painted .composer-halo layers.
//
// Activity level = actions in the last 6 s while a run is active:
//   0 → .2 · 1-3 → .36 · 4-7 → .52 · >7 → .66 · long tool call ("deep") → .56 · streaming → .62
// Pulses: an action "hits" (220 ms), a sub-agent check-in is "soft" (280 ms), each streamed
// token batch "ticks" (110 ms, at most every 230 ms). Done settles once (420 ms) then fades.

import { reactive, readonly } from 'vue';

export type ComposerGlowPulse = 'hit' | 'soft' | 'tick' | 'settle';

export interface ComposerGlowState {
  /** A run is active: the glow sits at its activity level. Off fades it out. */
  active:    boolean;
  /** 0-3, from the number of actions in the last 6 seconds. */
  level:     0 | 1 | 2 | 3;
  streaming: boolean;
  /** A single tool call has been running for a while. */
  deep:      boolean;
  /** Active but nothing has happened for a long time: the amber glow replaces the primary one. */
  stalled:   boolean;
  /** Window or tab hidden: nothing pulses and the timers stop. */
  paused:    boolean;
  pulses:    Record<ComposerGlowPulse, boolean>;
}

/** Timer seam so the glow can be driven by a fake clock. */
export interface ComposerGlowClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const browserGlowClock: ComposerGlowClock = {
  now:           () => Date.now(),
  setTimeout:    (fn, ms) => setTimeout(fn, ms),
  clearTimeout:  handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval:   (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class ComposerGlow {
  static readonly windowMs = 6_000;
  static readonly deepAfterMs = 2_500;
  static readonly stalledAfterMs = 90_000;
  static readonly streamTickMs = 230;
  static readonly streamIdleMs = 900;
  static readonly pulseMs: Readonly<Record<ComposerGlowPulse, number>> = { hit: 220, soft: 280, tick: 110, settle: 420 };

  private readonly mutable: ComposerGlowState = reactive({
    active: false, level: 0, streaming: false, deep: false, stalled: false, paused: false,
    pulses: { hit: false, soft: false, tick: false, settle: false },
  }) as ComposerGlowState;

  readonly state = readonly(this.mutable) as Readonly<ComposerGlowState>;

  private hits: number[] = [];
  private lastEventAt = 0;
  private lastTickAt = 0;
  private readonly runningTools = new Map<string, number>();
  private readonly pulseTimers = new Map<ComposerGlowPulse, unknown>();
  private streamTimer: unknown = null;
  private ticker: unknown = null;

  constructor(private readonly clock: ComposerGlowClock = browserGlowClock) {}

  /** Run started or ended. `settle` flashes once on a normal finish before fading. */
  setActive(active: boolean, settle = false): void {
    if (this.mutable.active === active) return;
    this.mutable.active = active;
    if (active) {
      this.hits = [];
      this.lastEventAt = this.clock.now();
    } else {
      this.reset();
      if (settle) this.flash('settle');
    }
    this.syncTicker();
    this.recompute();
  }

  setPaused(paused: boolean): void {
    if (this.mutable.paused === paused) return;
    this.mutable.paused = paused;
    if (paused) this.clearPulses();
    this.syncTicker();
    this.recompute();
  }

  /** A model action: a tool call or a primary-agent step. */
  action(): void {
    if (!this.mutable.active) return;
    this.touch(true);
    this.flash('hit');
  }

  /** A sub-agent check-in: counts as activity, pulses softer. */
  checkIn(): void {
    if (!this.mutable.active) return;
    this.touch(true);
    this.flash('soft');
  }

  toolStarted(id: string): void {
    if (!this.mutable.active) return;
    this.runningTools.set(id, this.clock.now());
    this.action();
  }

  toolFinished(id: string): void {
    const startedAt = this.runningTools.get(id);
    if (startedAt === undefined) return;
    this.runningTools.delete(id);
    const wasDeep = this.mutable.deep;
    this.recompute();
    // A long call ending is itself an event worth a hit; quick ones already hit on start.
    if (wasDeep) this.action();
  }

  /** One streamed batch of reply text. Throttled to the mockup's ~230 ms cadence. */
  streamed(): void {
    if (!this.mutable.active) return;
    this.touch(false);
    this.mutable.streaming = true;
    if (this.streamTimer !== null) this.clock.clearTimeout(this.streamTimer);
    this.streamTimer = this.clock.setTimeout(() => {
      this.streamTimer = null;
      this.mutable.streaming = false;
    }, ComposerGlow.streamIdleMs);
    const now = this.clock.now();
    if (now - this.lastTickAt < ComposerGlow.streamTickMs) return;
    this.lastTickAt = now;
    this.flash('tick');
  }

  /** Streaming phase from the run state machine, when the backend reports it. */
  setStreaming(on: boolean): void {
    if (!this.mutable.active && on) return;
    if (this.streamTimer !== null) { this.clock.clearTimeout(this.streamTimer); this.streamTimer = null }
    this.mutable.streaming = on;
    if (on) this.touch(false);
  }

  dispose(): void {
    this.reset();
    this.clearPulses();
    if (this.ticker !== null) this.clock.clearInterval(this.ticker);
    this.ticker = null;
  }

  private touch(countsAsAction: boolean): void {
    const now = this.clock.now();
    this.lastEventAt = now;
    if (countsAsAction) this.hits.push(now);
    this.recompute();
  }

  private recompute(): void {
    const now = this.clock.now();
    this.hits = this.hits.filter(at => now - at < ComposerGlow.windowMs);
    const n = this.hits.length;
    this.mutable.level = !this.mutable.active ? 0 : n > 7 ? 3 : n > 3 ? 2 : n > 0 ? 1 : 0;
    let oldestTool = Number.POSITIVE_INFINITY;
    for (const at of this.runningTools.values()) oldestTool = Math.min(oldestTool, at);
    this.mutable.deep = this.mutable.active && now - oldestTool >= ComposerGlow.deepAfterMs;
    // Waiting on a long tool or writing a reply is not a stall.
    this.mutable.stalled = this.mutable.active && !this.mutable.deep && !this.mutable.streaming
      && now - this.lastEventAt >= ComposerGlow.stalledAfterMs;
  }

  private flash(pulse: ComposerGlowPulse): void {
    if (this.mutable.paused) return;
    const pending = this.pulseTimers.get(pulse);
    if (pending !== undefined) this.clock.clearTimeout(pending);
    this.mutable.pulses[pulse] = true;
    this.pulseTimers.set(pulse, this.clock.setTimeout(() => {
      this.pulseTimers.delete(pulse);
      this.mutable.pulses[pulse] = false;
    }, ComposerGlow.pulseMs[pulse]));
  }

  private clearPulses(): void {
    for (const [pulse, handle] of this.pulseTimers) {
      this.clock.clearTimeout(handle);
      this.mutable.pulses[pulse] = false;
    }
    this.pulseTimers.clear();
  }

  private reset(): void {
    this.hits = [];
    this.runningTools.clear();
    if (this.streamTimer !== null) this.clock.clearTimeout(this.streamTimer);
    this.streamTimer = null;
    this.mutable.streaming = false;
    this.mutable.deep = false;
    this.mutable.stalled = false;
  }

  /** Level decay, deep and stall detection need a 1 s heartbeat, only while visible and running. */
  private syncTicker(): void {
    const want = this.mutable.active && !this.mutable.paused;
    if (want && this.ticker === null) {
      this.ticker = this.clock.setInterval(() => this.recompute(), 1_000);
    } else if (!want && this.ticker !== null) {
      this.clock.clearInterval(this.ticker);
      this.ticker = null;
    }
  }
}
