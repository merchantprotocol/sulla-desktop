// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { RelaySocketLike } from '@pkg/main/cloudRelayTransport';
import { RelayLivenessWatchdog } from '@pkg/main/relayLivenessWatchdog';

import { RELAY_SOCKET_OPEN, type DesktopRelayLog, type DesktopRelayTimers, type RelayInterval } from './DesktopRelayPorts';

// Heartbeat + watchdog tuned for Cloudflare Workers: the DO auto-responds to
// "ping" with "pong" via setWebSocketAutoResponse without waking from
// hibernation. A 20s ping interval + 45s silence watchdog keeps the pipe
// warm through NAT/proxy idle timeouts and surfaces silently-dead sockets
// (where TCP never FINs) well before Cloudflare's ~10min hibernation cutoff.
const PING_INTERVAL_MS = 20_000;
const STALE_SOCKET_MS = 45_000;
const WATCHDOG_DRIFT_THRESHOLD_MS = 5_000;
const WATCHDOG_PONG_DEADLINE_MS = 5_000;

/**
 * Pings the open relay socket and watches for inbound traffic. If the socket
 * goes silent the watchdog forces a reconnect — the `close` event alone is
 * unreliable when intermediaries drop the connection without a TCP FIN.
 */
export class DesktopRelayHeartbeat {
  private pingTimer: RelayInterval | null = null;
  private watchdog: RelayLivenessWatchdog | null = null;

  constructor(
    private readonly socket: () => RelaySocketLike | null,
    private readonly reconnect: (reason: string) => void,
    private readonly timers: DesktopRelayTimers,
    private readonly log: DesktopRelayLog,
  ) {}

  /** Start fresh; previous timers are cleared first so handles never leak. */
  start(): void {
    this.stop();
    this.pingTimer = this.timers.setInterval(() => {
      const ws = this.socket();
      if (!ws || ws.readyState !== RELAY_SOCKET_OPEN) return;
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* socket in bad state; watchdog will handle */ }
    }, PING_INTERVAL_MS);
    this.watchdog = new RelayLivenessWatchdog(
      { now: () => this.timers.now(), setTimeout: (callback, delayMs) => this.timers.setTimeout(callback, delayMs), clearTimeout: timer => this.timers.clearTimeout(timer) },
      {
        ping: () => {
          const ws = this.socket();
          if (ws?.readyState === RELAY_SOCKET_OPEN) ws.send(JSON.stringify({ type: 'ping' }));
        },
        reconnect: reason => this.reconnect(reason),
      },
      this.log,
      { staleSocketMs: STALE_SOCKET_MS, checkIntervalMs: Math.floor(STALE_SOCKET_MS / 3), driftThresholdMs: WATCHDOG_DRIFT_THRESHOLD_MS, pongDeadlineMs: WATCHDOG_PONG_DEADLINE_MS },
    );
    this.watchdog.start();
  }

  noteInbound(): void {
    this.watchdog?.noteInbound();
  }

  /** Idempotent. */
  stop(): void {
    if (this.pingTimer) { this.timers.clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.watchdog) { this.watchdog.stop(); this.watchdog = null; }
  }
}
