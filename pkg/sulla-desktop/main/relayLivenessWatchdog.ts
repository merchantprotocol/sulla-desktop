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
  info(message: string): void;
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
  private probeQueuedAt = 0;
  private probeSentAt = 0;

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
    this.probeQueuedAt = 0;
    this.probeSentAt = 0;
  }

  noteInbound(): void {
    this.lastInboundAt = this.scheduler.now();
    if (!this.awaitingExplicitPong) return;
    const observedAt = this.scheduler.now();
    this.logger.info(`[DesktopRelayProbe] ${ JSON.stringify({ event: 'pong_observed', queuedAt: this.probeQueuedAt, sentAt: this.probeSentAt, observedAt, elapsedMs: observedAt - this.probeSentAt }) }`);
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
      this.logger.warn(`[DesktopRelayProbe] ${ JSON.stringify({ event: 'watchdog_drift', driftMs, silentMs }) }`);
    }
    this.awaitingExplicitPong = true;
    this.probeQueuedAt = now;
    this.logger.info(`[DesktopRelayProbe] ${ JSON.stringify({ event: 'ping_queued', queuedAt: now, driftMs, silentMs }) }`);
    try {
      this.transport.ping();
      this.probeSentAt = this.scheduler.now();
      this.logger.info(`[DesktopRelayProbe] ${ JSON.stringify({ event: 'ping_sent', queuedAt: this.probeQueuedAt, sentAt: this.probeSentAt, queueDelayMs: this.probeSentAt - this.probeQueuedAt }) }`);
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
