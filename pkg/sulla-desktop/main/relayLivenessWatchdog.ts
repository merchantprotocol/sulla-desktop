// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface RelayWatchdogScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface RelayWatchdogTransport {
  ping(): void;
  reconnect(reason: string): void;
}

export interface RelayWatchdogLogger {
  warn(message: string): void;
}

export interface RelayWatchdogOptions {
  staleSocketMs: number;
  checkIntervalMs: number;
  driftThresholdMs: number;
  pongDeadlineMs: number;
}

export class RelayLivenessWatchdog {
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private expectedCheckAt = 0;
  private lastInboundAt = 0;
  private awaitingExplicitPong = false;

  constructor(
    private readonly scheduler: RelayWatchdogScheduler,
    private readonly transport: RelayWatchdogTransport,
    private readonly logger: RelayWatchdogLogger,
    private readonly options: RelayWatchdogOptions,
  ) {}

  start(): void {
    this.stop();
    this.lastInboundAt = this.scheduler.now();
    this.armCheck();
  }

  stop(): void {
    if (this.checkTimer) this.scheduler.clearTimeout(this.checkTimer);
    if (this.deadlineTimer) this.scheduler.clearTimeout(this.deadlineTimer);
    this.checkTimer = null;
    this.deadlineTimer = null;
    this.awaitingExplicitPong = false;
  }

  noteInbound(): void {
    this.lastInboundAt = this.scheduler.now();
    if (!this.awaitingExplicitPong) return;
    if (this.deadlineTimer) this.scheduler.clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
    this.awaitingExplicitPong = false;
    this.armCheck();
  }

  private armCheck(): void {
    if (this.checkTimer) this.scheduler.clearTimeout(this.checkTimer);
    this.expectedCheckAt = this.scheduler.now() + this.options.checkIntervalMs;
    this.checkTimer = this.scheduler.setTimeout(() => this.check(), this.options.checkIntervalMs);
  }

  private check(): void {
    this.checkTimer = null;
    const now = this.scheduler.now();
    const driftMs = Math.max(0, now - this.expectedCheckAt);
    const silentMs = now - this.lastInboundAt;
    if (silentMs <= this.options.staleSocketMs) {
      this.armCheck();
      return;
    }
    if (driftMs > this.options.driftThresholdMs) {
      this.logger.warn(`[DesktopRelay] Watchdog timer drifted ${ driftMs }ms; probing before reconnect (silent ${ silentMs }ms)`);
    }
    this.awaitingExplicitPong = true;
    try {
      this.transport.ping();
    } catch {
      this.awaitingExplicitPong = false;
      this.transport.reconnect('explicit liveness ping failed');
      return;
    }
    this.deadlineTimer = this.scheduler.setTimeout(() => {
      this.deadlineTimer = null;
      this.awaitingExplicitPong = false;
      this.transport.reconnect(`explicit pong deadline passed after ${ this.options.pongDeadlineMs }ms (silent ${ this.scheduler.now() - this.lastInboundAt }ms)`);
    }, this.options.pongDeadlineMs);
  }
}
