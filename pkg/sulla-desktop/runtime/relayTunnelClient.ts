// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { performance } from 'node:perf_hooks';

import WebSocket from 'ws';

import type {
  RelayEnvelope, RelayError, RelayToolCallEnvelope, RelayToolExecutionContext, RelayToolResult, RelayToolResultAckEnvelope,
} from './relayProtocol.js';
import {
  RELAY_RESULT_OUTBOX_ERROR_RESERVE_BYTES, RELAY_RESULT_OUTBOX_MAX_BYTES,
  RELAY_RESULT_OUTBOX_MAX_ENTRIES, RELAY_TOOL_RESULT_MAX_BYTES,
} from './relayProtocol.js';
import { ToolDeadlinePolicy } from '../../../packages/runtime-protocol/src/toolDeadlinePolicy.js';
import { LateToolResultStore, type LateToolResult } from './LateToolResultStore.js';

const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
const RESULT_RETRY_MS = 5_000;
const LATE_RESULT_WINDOW_MS = 10 * 60_000;
const MAX_DEADLINE_MS = new ToolDeadlinePolicy().maxDeadlineMs;
const ERROR_RESERVE_BYTES = RELAY_RESULT_OUTBOX_ERROR_RESERVE_BYTES;

export interface RelayToolTunnelOptions {
  relayUrl:      string;
  deviceToken:   string | (() => string | Promise<string>);
  deviceId:      () => Promise<string>;
  currentUserId: () => Promise<string>;
  execute:       (ctx: RelayToolExecutionContext, category: string, tool: string, args: unknown, signal: AbortSignal) => Promise<RelayToolResult>;
  operationTypes?: (category: string, tool: string) => readonly string[];
  lateResults?:    LateToolResultStore;
  createSocket?: (url: string, token: string) => WebSocket;
  log?:          Pick<Console, 'log' | 'warn' | 'error'>;
}

interface QueuedResult {
  envelope: RelayEnvelope;
  bytes: number;
  lastSentAt: number;
}

interface ActiveCall {
  controller: AbortController;
  startedAt: number;
  delay: number;
  timedOut: boolean;
  expired: boolean;
  settled: boolean;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

export function validateRelayToolCallUser(ctx: RelayToolExecutionContext, ownUserId: string): RelayError | null {
  if (!ownUserId || ctx.sub !== ownUserId) {
    return { code: 'FORBIDDEN', message: 'Tool call user does not own this Desktop' };
  }
  return null;
}

function byteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return Buffer.byteLength(encoded === undefined ? '' : encoded, 'utf8');
  } catch { return Number.POSITIVE_INFINITY }
}

function compactError(code: RelayError['code'], message: string): RelayError {
  return { code, message };
}

/** True when a rejection is the deadline abort itself, not a later tool failure. Message text is not a signal. */
function isDeadlineCancellation(cause: unknown, signal: AbortSignal): boolean {
  return signal.aborted && !!cause && typeof cause === 'object' && (cause as { name?: unknown }).name === 'AbortError';
}

export class RelayToolTunnel {
  private readonly deadlinePolicy = new ToolDeadlinePolicy();
  private readonly lateResults: LateToolResultStore;
  private socket:         WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private resultRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = BASE_RECONNECT_MS;
  private running = false;
  private calls = new Map<string, ActiveCall>();
  private readonly offers = new Map<string, RelayToolCallEnvelope>();
  /** Desktop-monotonic send time lets execute grants age across their entire round trip. */
  private readonly pendingClaims = new Map<string, number>();
  private readonly outbox = new Map<string, QueuedResult>();
  private outboxBytes = 0;

  constructor(private readonly options: RelayToolTunnelOptions) {
    this.lateResults = options.lateResults ?? new LateToolResultStore();
  }

  getLateResult(requestId: string): LateToolResult | undefined { return this.lateResults.get(requestId) }

  start(): void {
    if (this.running || !this.options.relayUrl || !this.options.deviceToken) return;
    this.running = true;
    this.connect().catch(error => this.options.log?.warn('[RelayToolTunnel] Connection failed:', error));
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.resultRetryTimer) clearTimeout(this.resultRetryTimer);
    this.reconnectTimer = null;
    this.resultRetryTimer = null;
    for (const call of this.calls.values()) {
      call.expired = true;
      call.controller.abort();
      if (call.expiryTimer) clearTimeout(call.expiryTimer);
    }
    this.calls.clear();
    this.offers.clear();
    this.pendingClaims.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    try {
      const deviceId = await this.options.deviceId();
      const deviceToken = typeof this.options.deviceToken === 'function'
        ? await this.options.deviceToken()
        : this.options.deviceToken;
      const base = this.options.relayUrl.replace(/^http/, 'ws').replace(/\/$/, '');
      const url = `${ base }/v1/tunnel?deviceId=${ encodeURIComponent(deviceId) }`;
      const socket = this.options.createSocket?.(url, deviceToken) ?? new WebSocket(url, {
        headers: { Authorization: `Bearer ${ deviceToken }` },
      });
      this.socket = socket;
      socket.on('open', () => {
        this.reconnectMs = BASE_RECONNECT_MS;
        this.options.log?.log(`[RelayToolTunnel] Connected as device ${ deviceId }`);
        this.flushOutbox();
        this.flushClaims();
      });
      socket.on('message', data => {
        this.handleMessage(String(data)).catch(error => this.options.log?.warn('[RelayToolTunnel] Message failed:', error));
      });
      socket.on('close', () => this.disconnected(socket));
      socket.on('error', () => this.disconnected(socket));
    } catch (error) {
      this.options.log?.warn('[RelayToolTunnel] Connection failed:', error);
      this.scheduleReconnect();
    }
  }

  private disconnected(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    if (this.resultRetryTimer) clearTimeout(this.resultRetryTimer);
    this.resultRetryTimer = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(error => this.options.log?.warn('[RelayToolTunnel] Connection failed:', error));
    }, delay + Math.floor(Math.random() * Math.min(1_000, delay / 4)));
  }

  /** Test seam is also the only application-message entry point from the relay. */
  async handleMessage(raw: string): Promise<void> {
    let envelope: RelayEnvelope;
    try { envelope = JSON.parse(raw) as RelayEnvelope } catch { return }
    if (envelope.type === 'tool-result-ack') {
      this.acknowledge(envelope);
      return;
    }
    if (envelope.type !== 'tool-call') return;
    const call = envelope;
    if (call.action === 'cancel') {
      this.offers.delete(call.requestId);
      this.pendingClaims.delete(call.requestId);
      this.cancel(call.requestId);
      return;
    }
    if (call.action === 'offer') {
      const error = await this.validateCall(call, false);
      if (error) {
        this.enqueueResult({
          type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId,
          requestFingerprint: call.requestFingerprint, resultRevision: 1, error,
        });
        return;
      }
      if (this.calls.has(call.requestId) || this.outbox.has(call.requestId)) {
        this.flushOutbox();
        return;
      }
      this.offers.set(call.requestId, call);
      this.flushClaims();
      return;
    }
    const claimSentAt = this.pendingClaims.get(call.requestId);
    if (!this.offers.has(call.requestId) || claimSentAt === undefined) return;
    const error = await this.validateCall(call, true);
    if (error) {
      this.offers.delete(call.requestId);
      this.pendingClaims.delete(call.requestId);
      this.enqueueResult({
        type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId,
        requestFingerprint: call.requestFingerprint, resultRevision: 1, error,
      });
      return;
    }
    this.offers.delete(call.requestId);
    this.pendingClaims.delete(call.requestId);
    // Redis-backed relay idempotency normally prevents duplicate dispatches. This
    // local fence protects against reordered bus deliveries and overlapping sockets.
    if (this.calls.has(call.requestId) || this.outbox.has(call.requestId)) {
      this.flushOutbox();
      return;
    }

    // remainingMs is stamped from Redis PTTL when the claim reaches the relay.
    // Subtract the full Desktop-monotonic claim round trip, including response transit,
    // so a delayed grant cannot renew an already-expired request lease.
    const claimRoundTripMs = Math.max(0, Math.ceil(performance.now() - claimSentAt));
    const delay = call.remainingMs! - claimRoundTripMs;
    if (delay <= 0) {
      this.enqueueResult({
        type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId,
        requestFingerprint: call.requestFingerprint, resultRevision: 1,
        error: {
          code: 'DEADLINE_EXCEEDED', message: 'The relay lease expired while its execution grant was in transit',
          details: { sideEffectUnknown: false, claimRoundTripMs },
        },
      });
      return;
    }
    const active: ActiveCall = {
      controller: new AbortController(), startedAt: performance.now(), delay,
      timedOut: false, expired: false, settled: false, expiryTimer: null,
    };
    this.calls.set(call.requestId, active);
    let rejectDeadline: (error: Error) => void = () => undefined;
    const timer = setTimeout(() => {
      active.timedOut = true;
      // Reject before abort so the race observes the timeout even when the tool settles inside abort().
      rejectDeadline(new Error('deadline'));
      active.controller.abort();
    }, delay);
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const execution = Promise.resolve().then(() => this.options.execute(call.ctx!, call.category!, call.tool!, call.args, active.controller.signal));
    const releaseCall = () => {
      if (this.calls.get(call.requestId) === active) this.calls.delete(call.requestId);
      this.flushClaims();
    };
    // One canonical primary (revision 1) and one buffered original outcome. Settlement timing
    // never decides whether an outcome is kept: after a timeout primary, every original value or
    // genuine failure becomes late revision 2 exactly once; only a deadline AbortError is cancellation.
    let primary: 'on-time' | 'timeout' | null = null;
    let outcome: { kind: 'value'; result: RelayToolResult } | { kind: 'error'; cause: unknown } | null = null;
    let lateHandled = false;
    const deliverLate = () => {
      if (primary !== 'timeout' || !outcome || lateHandled) return;
      lateHandled = true;
      const settled = outcome;
      if (!active.expired && performance.now() - active.startedAt <= active.delay + LATE_RESULT_WINDOW_MS
        && !(settled.kind === 'error' && isDeadlineCancellation(settled.cause, active.controller.signal))) {
        const late = settled.kind === 'value'
          ? this.lateResults.record(call.requestId, settled.result)
          : this.lateResults.record(call.requestId, undefined, settled.cause);
        this.options.log?.warn(`[RelayToolTunnel] Late tool result for ${ call.requestId }: ${ late.outcome }`);
        this.enqueueResult(settled.kind === 'value'
          ? {
            type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId,
            requestFingerprint: call.requestFingerprint, resultRevision: 2, late: true, result: settled.result,
          }
          : {
            type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId, resultRevision: 2, late: true,
            requestFingerprint: call.requestFingerprint,
            error: { code: 'INTERNAL', message: settled.cause instanceof Error ? settled.cause.message : String(settled.cause) },
          });
      }
      // The late original outcome is retained above before its reservation is released.
      releaseCall();
    };
    const settle = (settled: NonNullable<typeof outcome>) => {
      active.settled = true;
      if (active.expiryTimer) clearTimeout(active.expiryTimer);
      outcome ??= settled;
      // Before the primary is published the continuation below owns publication and release.
      deliverLate();
    };
    execution.then(result => settle({ kind: 'value', result }), cause => settle({ kind: 'error', cause }));

    active.expiryTimer = setTimeout(() => {
      active.expired = true;
      active.controller.abort();
      if (this.calls.get(call.requestId) === active) this.calls.delete(call.requestId);
    }, delay + LATE_RESULT_WINDOW_MS);

    const publishPrimaryTimeout = () => {
      const elapsedMs = Math.max(0, Math.round(performance.now() - active.startedAt));
      const operationTypes = call.operationTypes ?? this.options.operationTypes?.(call.category!, call.tool!) ?? [];
      const error: RelayError = {
        code:      'DEADLINE_EXCEEDED',
        message:   `Desktop tool call deadline exceeded: ${ call.category }/${ call.tool } ran ${ elapsedMs } ms of its ${ delay } ms deadline; this timeout is retryable, and a late result is kept on Desktop for 10 minutes`,
        retryable: true,
        details:   this.deadlinePolicy.timeoutDetails(call.tool!, delay, elapsedMs, operationTypes),
      };
      this.enqueueResult({
        type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId,
        requestFingerprint: call.requestFingerprint, resultRevision: 1, provisional: true, error,
      });
      primary = 'timeout';
      // An outcome that settled before or during the abort is now kept as revision 2.
      deliverLate();
    };
    try {
      const result = await Promise.race([execution, deadline]);
      if (active.timedOut) {
        // The tool resolved during the deadline abort: report the timeout first, then keep the value late.
        outcome ??= { kind: 'value', result };
        publishPrimaryTimeout();
      } else {
        this.enqueueResult({
          type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId,
          requestFingerprint: call.requestFingerprint, resultRevision: 1, result,
        });
        primary = 'on-time';
      }
    } catch (cause) {
      const timedOut = active.timedOut || active.controller.signal.aborted;
      if (timedOut) publishPrimaryTimeout();
      else {
        this.enqueueResult({
          type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId,
          requestFingerprint: call.requestFingerprint, resultRevision: 1,
          error: { code: 'INTERNAL', message: cause instanceof Error ? cause.message : String(cause) },
        });
        primary = 'on-time';
      }
    } finally {
      clearTimeout(timer);
      if (active.settled && primary === 'on-time') {
        if (active.expiryTimer) clearTimeout(active.expiryTimer);
        // The on-time result is in the outbox now; only then may the slot go to a queued offer.
        releaseCall();
      }
    }
  }

  private cancel(requestId: string): void {
    const active = this.calls.get(requestId);
    if (!active) return;
    active.expired = true;
    active.controller.abort();
    if (active.expiryTimer) clearTimeout(active.expiryTimer);
    this.calls.delete(requestId);
  }

  private acknowledge(ack: RelayToolResultAckEnvelope): void {
    const current = this.outbox.get(ack.requestId);
    if (!current || current.envelope.type !== 'tool-result') return;
    if (current.envelope.deviceId !== ack.deviceId || current.envelope.requestFingerprint !== ack.requestFingerprint
      || (current.envelope.resultRevision ?? 1) > ack.resultRevision) return;
    this.outbox.delete(ack.requestId);
    this.offers.delete(ack.requestId);
    this.pendingClaims.delete(ack.requestId);
    this.outboxBytes -= current.bytes;
    if (this.outboxBytes < 0) this.outboxBytes = 0;
    this.scheduleResultRetry();
    this.flushClaims();
  }

  private enqueueResult(envelope: Extract<RelayEnvelope, { type: 'tool-result' }>): void {
    const prior = this.outbox.get(envelope.requestId);
    // A duplicate or reordered publication must not replace a newer retained result.
    if (prior?.envelope.type === 'tool-result' && (envelope.resultRevision ?? 1) < (prior.envelope.resultRevision ?? 1)) return;
    if (envelope.result && byteLength(envelope.result) > RELAY_TOOL_RESULT_MAX_BYTES) {
      envelope = {
        type: 'tool-result', requestId: envelope.requestId, deviceId: envelope.deviceId,
        requestFingerprint: envelope.requestFingerprint,
        resultRevision: envelope.resultRevision,
        ...(envelope.provisional ? { provisional: true } : {}), ...(envelope.late ? { late: true } : {}),
        error: compactError('RESULT_TOO_LARGE', `Desktop tool result exceeds the ${ RELAY_TOOL_RESULT_MAX_BYTES } byte per-result limit`),
      };
    }
    let bytes = byteLength(envelope);
    const dataBudget = RELAY_RESULT_OUTBOX_MAX_BYTES - ERROR_RESERVE_BYTES;
    const nextBytes = this.outboxBytes - (prior?.bytes ?? 0) + bytes;
    if (nextBytes > dataBudget && !envelope.error) {
      envelope = {
        type: 'tool-result', requestId: envelope.requestId, deviceId: envelope.deviceId,
        requestFingerprint: envelope.requestFingerprint,
        resultRevision: envelope.resultRevision,
        ...(envelope.provisional ? { provisional: true } : {}), ...(envelope.late ? { late: true } : {}),
        error: compactError('RESULT_TOO_LARGE', 'Desktop result could not fit in the bounded reconnect outbox'),
      };
      bytes = byteLength(envelope);
    }
    if (this.outbox.size - (prior ? 1 : 0) >= RELAY_RESULT_OUTBOX_MAX_ENTRIES || this.outboxBytes - (prior?.bytes ?? 0) + bytes > RELAY_RESULT_OUTBOX_MAX_BYTES) {
      this.options.log?.error(`[RelayToolTunnel] Bounded result outbox is full; refusing new result ${ envelope.requestId }`);
      return;
    }
    this.outboxBytes = this.outboxBytes - (prior?.bytes ?? 0) + bytes;
    this.outbox.set(envelope.requestId, { envelope, bytes, lastSentAt: 0 });
    this.flushOutbox();
  }

  private flushOutbox(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    for (const item of this.outbox.values()) {
      if (item.lastSentAt && now - item.lastSentAt < RESULT_RETRY_MS) continue;
      try {
        socket.send(JSON.stringify(item.envelope));
        item.lastSentAt = now;
      } catch (error) {
        this.options.log?.warn('[RelayToolTunnel] Result send failed; retaining it for reconnect:', error);
        this.disconnected(socket);
        return;
      }
    }
    this.scheduleResultRetry();
  }

  private flushClaims(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const offer of this.offers.values()) {
      if (this.pendingClaims.has(offer.requestId)) continue;
      if (this.calls.size + this.pendingClaims.size + this.outbox.size >= RELAY_RESULT_OUTBOX_MAX_ENTRIES) return;
      this.pendingClaims.set(offer.requestId, performance.now());
      try {
        socket.send(JSON.stringify({
          type: 'tool-call-claim', requestId: offer.requestId, deviceId: offer.deviceId,
          requestFingerprint: offer.requestFingerprint,
        }));
      } catch (error) {
        this.pendingClaims.delete(offer.requestId);
        this.options.log?.warn('[RelayToolTunnel] Lease claim send failed; retaining it for reconnect:', error);
        this.disconnected(socket);
        return;
      }
    }
  }

  private scheduleResultRetry(): void {
    if (this.resultRetryTimer) clearTimeout(this.resultRetryTimer);
    this.resultRetryTimer = null;
    if (!this.outbox.size || !this.running || this.socket?.readyState !== WebSocket.OPEN) return;
    this.resultRetryTimer = setTimeout(() => {
      this.resultRetryTimer = null;
      this.flushOutbox();
    }, RESULT_RETRY_MS);
    this.resultRetryTimer.unref?.();
  }

  private async validateCall(call: RelayToolCallEnvelope, requireBudget: boolean): Promise<RelayError | null> {
    if (!call.ctx || !call.category || !call.tool || !call.requestFingerprint || !/^[a-f0-9]{64}$/.test(call.requestFingerprint)
      || (requireBudget && (!Number.isFinite(call.remainingMs) || !call.remainingMs || call.remainingMs < 0))) {
      return { code: 'BAD_REQUEST', message: 'Incomplete tool-call envelope' };
    }
    if (requireBudget && call.remainingMs! > MAX_DEADLINE_MS) {
      return { code: 'BAD_REQUEST', message: 'Relay supplied a tool budget above the shared maximum' };
    }
    if (call.ctx.device_id && call.ctx.device_id !== call.deviceId) {
      return { code: 'FORBIDDEN', message: 'Tool capability is bound to a different Desktop device' };
    }
    return validateRelayToolCallUser(call.ctx, await this.options.currentUserId());
  }
}
