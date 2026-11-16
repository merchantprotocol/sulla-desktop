// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { RelayFailureKind, RelaySocketLike } from '@pkg/main/cloudRelayTransport';

import { DesktopRelayHeartbeat } from './DesktopRelayHeartbeat';
import {
  DURABLE_RELAY_FRAME_TYPES, RELAY_SOCKET_CONNECTING, RELAY_SOCKET_OPEN,
  type DesktopRelayLog, type DesktopRelaySessionPorts, type DesktopRelaySocketPorts, type DesktopRelayStatus,
  type DesktopRelayTimers, type RelayFrame, type RelayTimeout,
} from './DesktopRelayPorts';

const RELAY_URL = 'wss://sulla-workers.merchantprotocol.workers.dev';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 5 * 60_000;
// While the vault is locked, re-check this often (a cheap local status call)
// so the relay reconnects promptly after unlock without exponential delay.
const VAULT_LOCKED_RETRY_MS = 5_000;
const RELAY_LIVENESS_HOLDER = 'desktop-relay';
// If a freshly-opened socket doesn't fire `open` in this window, we assume
// it's stuck and tear it down. Prevents a wedged connect from pinning the
// client in "connecting" forever.
const CONNECT_TIMEOUT_MS = 15_000;

/** What the transport tells its owner about socket traffic and teardown. */
export interface DesktopRelayTransportEvents {
  message(raw: string, socket: RelaySocketLike, generation: number): void;
  /** A socket was released; abort work bound to it (all sockets when omitted). */
  socketReleased(socket?: RelaySocketLike, generation?: number): void;
  /** The pairing was dropped; per-conversation state must be cleared. */
  sessionReset(): void;
  /** A frame reached an open socket. */
  frameDelivered(): void;
}

function describeFailure(kind: RelayFailureKind): string {
  switch (kind) {
  case 'vault_locked': return 'Restoring the signed-in encrypted session — relay will retry';
  case 'signed_out': return 'Sulla Cloud sign-in required — relay cannot authenticate';
  case 'denied': return 'Vault policy denied the Sulla Cloud relay';
  default: return 'Sulla Cloud relay unavailable — retrying with backoff';
  }
}

/**
 * The relay WebSocket: connect, reconnect with backoff, heartbeat/watchdog,
 * suspend/resume and the durable outbound queue. One socket at a time.
 */
export class DesktopRelayTransport {
  private ws: RelaySocketLike | null = null;
  /** Last logged connection state; logs only on change to avoid retry spam. */
  private loggedState = '';
  /** Failure kind of the last vault relay attempt; picks the next backoff. */
  private lastFailure: RelayFailureKind | null = null;
  private currentDeviceId = '';
  private currentRoom: string | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private reconnectTimer: RelayTimeout | null = null;
  /** Consecutive failed reconnect cycles — drives log suppression only. */
  private failedAttempts = 0;
  private intentionallyClosed = false;
  private connected = false;
  private lastError = '';
  private statusListeners: Array<(s: DesktopRelayStatus) => void> = [];
  private readonly heartbeat: DesktopRelayHeartbeat;
  // Guards against a stuck socket that never resolves to `open`.
  private connectTimeoutTimer: RelayTimeout | null = null;
  // Bumped per openSocket() call so a slower concurrent call can't open a
  // second socket after the token/device-id awaits.
  private openGeneration = 0;
  // Critical completion frames (done/stopped/error) that couldn't be sent
  // because the socket was reconnecting. Flushed immediately on `open`.
  private pendingFrames: string[] = [];
  // System-sleep gate. While the machine is suspended we close the socket on
  // purpose and must not schedule reconnects that can't succeed.
  private suspended = false;

  constructor(
    private readonly sockets: DesktopRelaySocketPorts,
    private readonly session: DesktopRelaySessionPorts,
    private readonly timers: DesktopRelayTimers,
    private readonly log: DesktopRelayLog,
    private readonly events: DesktopRelayTransportEvents,
  ) {
    this.heartbeat = new DesktopRelayHeartbeat(() => this.ws, reason => this.forceReconnect(reason), timers, log);
  }

  get deviceId(): string { return this.currentDeviceId }
  set deviceId(value: string) { this.currentDeviceId = value }
  get socket(): RelaySocketLike | null { return this.ws }
  get generation(): number { return this.openGeneration }

  getStatus(): DesktopRelayStatus {
    return { pairedUserId: this.currentRoom ?? '', connected: this.connected, lastError: this.lastError || undefined };
  }

  onStatusChange(listener: (s: DesktopRelayStatus) => void): () => void {
    this.statusListeners.push(listener);
    return () => {
      this.statusListeners = this.statusListeners.filter(l => l !== listener);
    };
  }

  broadcastStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try { listener(status); } catch { /* ignore */ }
    }
  }

  connect(room: string): void {
    this.intentionallyClosed = false;
    this.currentRoom = room;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.openSocket().catch((err) => {
      this.noteState('error', `openSocket failed: ${ err?.message || err }`);
      // A throw here (e.g. token/DB read during boot) previously left the
      // relay dead until app restart. Hand the failure to the backoff machinery.
      this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownLiveness();
    this.events.socketReleased();
    this.pendingFrames = [];
    this.events.sessionReset();
    this.closeCurrent();
    this.currentRoom = null;
    this.connected = false;
    this.broadcastStatus();
  }

  /** powerMonitor 'suspend': close the socket proactively; no reconnects while suspended. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (!this.currentRoom) return;
    this.log.log('[DesktopRelay] System suspending — closing relay socket');
    if (this.reconnectTimer) { this.timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.teardownLiveness();
    this.events.socketReleased();
    this.closeCurrent();
    this.connected = false;
    this.broadcastStatus();
  }

  /** powerMonitor 'resume': reconnect with fresh backoff instead of waiting for the watchdog. */
  resume(): void {
    this.suspended = false;
    if (!this.currentRoom || this.intentionallyClosed) return;
    this.log.log('[DesktopRelay] System resumed — reconnecting relay socket');
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.failedAttempts = 0;
    this.forceReconnect('system resumed');
  }

  /** Send a frame, queueing durable ones while the socket is down. */
  send(payload: RelayFrame, type: string | undefined): void {
    const json = JSON.stringify(payload);
    if (!this.ws || this.ws.readyState !== RELAY_SOCKET_OPEN) {
      // Streaming/activity frames are ephemeral — dropping them is acceptable.
      if (type && DURABLE_RELAY_FRAME_TYPES.includes(type)) {
        this.pendingFrames.push(json);
        this.log.warn(`[DesktopRelay] Queued ${ type } frame — socket not open`);
      } else {
        this.log.warn('[DesktopRelay] Dropped frame — socket not open:', type);
      }
      return;
    }
    try {
      this.ws.send(json);
      this.events.frameDelivered();
    } catch (err) {
      this.log.warn('[DesktopRelay] Send failed:', err);
    }
  }

  /** Send without queueing; used only for malformed-frame rejections. */
  sendUnchecked(payload: RelayFrame): void {
    const json = JSON.stringify(payload);
    if (!this.ws || this.ws.readyState !== RELAY_SOCKET_OPEN) {
      this.log.warn('[DesktopRelay] Dropped malformed-frame error — socket not open');
      return;
    }
    try {
      this.ws.send(json);
    } catch (err) {
      this.log.warn('[DesktopRelay] Send failed:', err);
    }
  }

  /** Log one line per connection-state change; repeats of the same state stay quiet. */
  private noteState(state: string, detail: string): void {
    const key = `${ state }:${ detail }`;
    if (key === this.loggedState) return;
    this.loggedState = key;
    if (state === 'connected') this.log.log(`[DesktopRelay] ${ detail }`);
    else this.log.warn(`[DesktopRelay] ${ detail }`);
  }

  private closeCurrent(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  /** Stop all heartbeat/watchdog/connect timers. Idempotent. */
  private teardownLiveness(): void {
    this.session.releaseLiveness(RELAY_LIVENESS_HOLDER);
    this.heartbeat.stop();
    if (this.connectTimeoutTimer) { this.timers.clearTimeout(this.connectTimeoutTimer); this.connectTimeoutTimer = null; }
  }

  /** Every failure path funnels here so we can't leak sockets or timers. */
  private forceReconnect(reason: string): void {
    if (this.intentionallyClosed) return;
    if (this.connected) this.noteState('reconnecting', `Forcing reconnect — ${ reason }`);
    this.teardownLiveness();
    this.events.socketReleased();
    if (this.ws) {
      this.recoverVaultOutbound(this.ws);
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.connected = false;
    this.broadcastStatus();
    this.scheduleReconnect();
  }

  private async openSocket(): Promise<void> {
    if (!this.currentRoom || this.suspended) return;
    // Never run two sockets at once: both would join the room under the same
    // deviceId and the DO would evict one in an endless loop.
    if (this.ws && (this.ws.readyState === RELAY_SOCKET_OPEN || this.ws.readyState === RELAY_SOCKET_CONNECTING)) return;
    const room = this.currentRoom;
    const gen = ++this.openGeneration;
    const superseded = () => this.suspended || this.intentionallyClosed || gen !== this.openGeneration;

    let ws: RelaySocketLike;
    if (this.sockets.usesVault()) {
      // Container vault: the vault owns the session token and opens the
      // relay socket itself; this process never sees the credential.
      this.currentDeviceId = await this.session.deviceId();
      if (superseded()) return;
      ws = this.sockets.openVault(room, this.currentDeviceId);
    } else {
      const token = await this.session.accessToken();
      if (superseded()) return;
      if (!token) {
        this.lastError = 'Not signed in — relay cannot authenticate';
        this.noteState('signed_out', 'No access token — waiting for sign-in');
        this.broadcastStatus();
        // Retry later; a successful sign-in will re-trigger via setPairedUserId.
        this.scheduleReconnect();
        return;
      }
      this.currentDeviceId = await this.session.deviceId();
      if (superseded()) return;
      // Never log this URL: it carries the token.
      ws = this.sockets.openNative(`${ RELAY_URL }/relay/${ encodeURIComponent(room) }?role=desktop&deviceId=${ encodeURIComponent(this.currentDeviceId) }&token=${ encodeURIComponent(token) }`);
    }
    this.ws = ws;
    this.connectTimeoutTimer = this.timers.setTimeout(() => {
      this.connectTimeoutTimer = null;
      if (this.ws === ws && !this.connected) this.forceReconnect(`connect timeout after ${ CONNECT_TIMEOUT_MS }ms`);
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener('open', () => this.handleOpen(ws, room));
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return;
      this.heartbeat.noteInbound();
      this.events.message(event.data as string, ws, gen);
    });
    ws.addEventListener('close', () => this.handleClose(ws, gen));
    ws.addEventListener('error', (e: any) => this.handleError(ws, e));
  }

  private handleOpen(ws: RelaySocketLike, room: string): void {
    // A superseded socket must not become a second live peer.
    if (this.ws !== ws) {
      try { ws.close(); } catch { /* ignore */ }
      return;
    }
    if (this.connectTimeoutTimer) { this.timers.clearTimeout(this.connectTimeoutTimer); this.connectTimeoutTimer = null; }
    this.connected = true;
    this.session.acquireLiveness(RELAY_LIVENESS_HOLDER);
    this.lastError = '';
    this.lastFailure = null;
    this.reconnectDelay = RECONNECT_BASE_MS;
    this.noteState('connected', `Connected — room=${ room }${ this.failedAttempts > 1 ? ` (recovered after ${ this.failedAttempts } attempts)` : '' }`);
    this.failedAttempts = 0;
    this.broadcastStatus();

    // Flush frames queued while the socket was reconnecting.
    const pending = this.pendingFrames.splice(0);
    for (const frame of pending) {
      try { ws.send(frame); } catch (err) { this.log.warn('[DesktopRelay] Failed to flush pending frame:', err); }
    }

    // Start the heartbeat: ping every 20s and force a reconnect on silence.
    this.heartbeat.start();
  }

  private handleClose(ws: RelaySocketLike, gen: number): void {
    // Abort reads owned by this exact connection even if its close arrives
    // after a replacement socket has already become current.
    this.events.socketReleased(ws, gen);
    // A replaced socket's late close must not tear down the live one.
    if (this.ws !== ws) return;
    this.recoverVaultOutbound(ws);
    this.ws = null;
    this.connected = false;
    this.teardownLiveness();
    this.recordFailure(ws);
    const detail = this.failureDetailSuffix(ws);
    this.noteState('closed', this.lastFailure ? `${ describeFailure(this.lastFailure) }${ detail }` : `Socket closed${ detail }`);
    this.broadcastStatus();
    if (!this.intentionallyClosed) this.scheduleReconnect();
  }

  private handleError(ws: RelaySocketLike, e: any): void {
    if (this.ws !== ws) return;
    this.recordFailure(ws);
    const detail = this.failureDetailSuffix(ws);
    this.lastError = this.lastFailure ? `${ describeFailure(this.lastFailure) }${ detail }` : (e?.message || 'WebSocket error');
    this.noteState(this.lastFailure ?? 'error', this.lastError);
    this.broadcastStatus();
    // Some runtimes don't fire `close` after `error`; never sit idle waiting.
    this.forceReconnect(`socket error: ${ this.lastError }`);
  }

  private failureDetailSuffix(ws: RelaySocketLike): string {
    const view = this.sockets.vaultView(ws);
    return view && view.failureDetail ? ` (${ view.failureDetail })` : '';
  }

  /** Capture a vault relay failure kind (if any) for status and backoff. */
  private recordFailure(ws: RelaySocketLike): void {
    const view = this.sockets.vaultView(ws);
    if (view && view.failure) this.lastFailure = view.failure;
  }

  /** Preserve only durable chat frames from an asynchronously failing vault send queue. */
  private recoverVaultOutbound(ws: RelaySocketLike): void {
    const view = this.sockets.vaultView(ws);
    if (!view) return;
    for (const frame of view.takePendingOutbound()) {
      try {
        const type = JSON.parse(frame)?.type;
        if (DURABLE_RELAY_FRAME_TYPES.includes(type)) {
          if (!this.pendingFrames.includes(frame)) this.pendingFrames.push(frame);
        }
      } catch { /* malformed frames were never durable */ }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.currentRoom || this.suspended) return;
    // A locked vault is polled at a short fixed interval so unlock reconnects
    // promptly; every other failure backs off exponentially (cap 5 min).
    const delay = this.lastFailure === 'vault_locked' ? VAULT_LOCKED_RETRY_MS : this.reconnectDelay;
    if (this.lastFailure !== 'vault_locked') this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.failedAttempts++;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket().catch((err) => {
        this.noteState('error', `openSocket failed: ${ err?.message || err }`);
        // Without rescheduling here, a single throw killed the reconnect loop permanently.
        this.scheduleReconnect();
      });
    }, delay);
  }
}
