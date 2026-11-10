// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Tells cloud sync when the laptop is reachable again: the network came back,
 * or the machine resumed from sleep or the lock screen. Bursts collapse into one
 * 'online' notification.
 */

export const NETWORK_POLL_MS = 15_000;
export const NETWORK_RESUME_DEBOUNCE_MS = 3_000;

export interface NetworkStatusSource { isOnline(): boolean }

export type PowerWakeEvent = 'resume' | 'unlock-screen';

export interface PowerEventSource {
  on(event: PowerWakeEvent, listener: () => void): unknown;
  removeListener(event: PowerWakeEvent, listener: () => void): unknown;
}

export interface MonitorScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface NetworkResumeMonitorOptions {
  network: NetworkStatusSource;
  power: PowerEventSource;
  scheduler?: MonitorScheduler;
  pollMs?: number;
  debounceMs?: number;
}

const DEFAULT_SCHEDULER: MonitorScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class NetworkResumeMonitor {
  private readonly listeners = new Set<() => void>();
  private readonly scheduler: MonitorScheduler;
  private readonly pollMs: number;
  private readonly debounceMs: number;
  private pollHandle: unknown = null;
  private debounceHandle: unknown = null;
  private lastOnline = true;
  private readonly onPowerWake = (): void => this.handleWake();

  constructor(private readonly options: NetworkResumeMonitorOptions) {
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.pollMs = options.pollMs ?? NETWORK_POLL_MS;
    this.debounceMs = options.debounceMs ?? NETWORK_RESUME_DEBOUNCE_MS;
  }

  /** Subscribe to 'online'. Returns an unsubscribe function. */
  onOnline(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    if (this.pollHandle !== null) return;
    this.lastOnline = this.options.network.isOnline();
    this.options.power.on('resume', this.onPowerWake);
    this.options.power.on('unlock-screen', this.onPowerWake);
    this.pollHandle = this.scheduler.setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.pollHandle !== null) this.scheduler.clearInterval(this.pollHandle);
    if (this.debounceHandle !== null) this.scheduler.clearTimeout(this.debounceHandle);
    this.pollHandle = null;
    this.debounceHandle = null;
    this.options.power.removeListener('resume', this.onPowerWake);
    this.options.power.removeListener('unlock-screen', this.onPowerWake);
  }

  private poll(): void {
    const online = this.options.network.isOnline();
    const cameBack = online && !this.lastOnline;
    this.lastOnline = online;
    if (cameBack) this.scheduleNotify();
  }

  // Resume is a reason to reconnect even when the network never dropped (sleeping sockets go stale).
  private handleWake(): void {
    this.lastOnline = this.options.network.isOnline();
    if (this.lastOnline) this.scheduleNotify();
  }

  private scheduleNotify(): void {
    if (this.debounceHandle !== null) this.scheduler.clearTimeout(this.debounceHandle);
    this.debounceHandle = this.scheduler.setTimeout(() => {
      this.debounceHandle = null;
      this.notify();
    }, this.debounceMs);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch (err) { console.warn('[NetworkResumeMonitor] online listener failed:', err) }
    }
  }
}
