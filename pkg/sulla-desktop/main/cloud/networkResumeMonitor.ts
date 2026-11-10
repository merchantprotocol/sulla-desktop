// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { EventEmitter } from 'events';

/** Quiet period after the last trigger; bursts of resume/online signals collapse into one 'online'. */
export const NETWORK_RESUME_DEBOUNCE_MS = 3_000;
/** How often connectivity is polled, since Electron emits no event when the network returns. */
export const NETWORK_POLL_MS = 10_000;

export type PowerResumeEvent = 'resume' | 'unlock-screen';

export interface NetworkResumePowerSource {
  on(event: PowerResumeEvent, listener: () => void): unknown;
  removeListener(event: PowerResumeEvent, listener: () => void): unknown;
}

export interface NetworkStatusSource { isOnline(): boolean }

export interface NetworkResumeClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface NetworkResumeDeps {
  power: NetworkResumePowerSource;
  net: NetworkStatusSource;
  clock?: NetworkResumeClock;
}

const SYSTEM_CLOCK: NetworkResumeClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Emits 'online' once connectivity is back: when the network flips from down to up,
 * or when the machine resumes or unlocks while online. Bursts are debounced.
 */
export class NetworkResumeMonitor extends EventEmitter {
  private readonly clock: NetworkResumeClock;
  private wasOnline: boolean;
  private debounce: unknown = null;
  private poll: unknown = null;
  private readonly onPowerResume = (): void => this.scheduleEmit();

  constructor(private readonly deps: NetworkResumeDeps) {
    super();
    this.clock = deps.clock ?? SYSTEM_CLOCK;
    this.wasOnline = deps.net.isOnline();
  }

  start(): void {
    if (this.poll) return;
    this.deps.power.on('resume', this.onPowerResume);
    this.deps.power.on('unlock-screen', this.onPowerResume);
    this.poll = this.clock.setInterval(() => this.checkConnectivity(), NETWORK_POLL_MS);
  }

  stop(): void {
    this.deps.power.removeListener('resume', this.onPowerResume);
    this.deps.power.removeListener('unlock-screen', this.onPowerResume);
    if (this.poll) this.clock.clearInterval(this.poll);
    if (this.debounce) this.clock.clearTimeout(this.debounce);
    this.poll = null;
    this.debounce = null;
  }

  private checkConnectivity(): void {
    const online = this.deps.net.isOnline();
    const cameBack = online && !this.wasOnline;
    this.wasOnline = online;
    if (cameBack) this.scheduleEmit();
  }

  private scheduleEmit(): void {
    if (this.debounce) this.clock.clearTimeout(this.debounce);
    this.debounce = this.clock.setTimeout(() => {
      this.debounce = null;
      const online = this.deps.net.isOnline();
      this.wasOnline = online;
      // Still offline after a resume: the poll emits once the network returns.
      if (online) this.emit('online');
    }, NETWORK_RESUME_DEBOUNCE_MS);
  }
}
