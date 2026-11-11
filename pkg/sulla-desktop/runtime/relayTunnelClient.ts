// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import WebSocket from 'ws';

import type {
  RelayEnvelope, RelayError, RelayToolCallEnvelope, RelayToolExecutionContext, RelayToolResult,
} from './relayProtocol.js';
import { ToolDeadlinePolicy } from '../../../packages/runtime-protocol/src/toolDeadlinePolicy.js';
import { LateToolResultStore, type LateToolResult } from './LateToolResultStore.js';

const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;

export interface RelayToolTunnelOptions {
  relayUrl:      string;
  deviceToken:   string | (() => string | Promise<string>);
  deviceId:      () => Promise<string>;
  currentUserId: () => Promise<string>;
  execute:       (ctx: RelayToolExecutionContext, category: string, tool: string, args: unknown, signal: AbortSignal) => Promise<RelayToolResult>;
  operationTypes?: (category: string, tool: string) => readonly string[];
  lateResults?:    LateToolResultStore;
  createSocket?: (url: string, token: string) => WebSocket;
  log?:          Pick<Console, 'log' | 'warn'>;
}

export function validateRelayToolCallUser(ctx: RelayToolExecutionContext, ownUserId: string): RelayError | null {
  if (!ownUserId || ctx.sub !== ownUserId) {
    return { code: 'FORBIDDEN', message: 'Tool call user does not own this Desktop' };
  }
  return null;
}

export class RelayToolTunnel {
  private readonly deadlinePolicy = new ToolDeadlinePolicy();
  private readonly lateResults: LateToolResultStore;
  private socket:         WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = BASE_RECONNECT_MS;
  private running = false;
  private calls = new Map<string, AbortController>();

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
    this.reconnectTimer = null;
    for (const call of this.calls.values()) call.abort();
    this.calls.clear();
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

  /** Test seam used by the focused cross-user security test. */
  async handleMessage(raw: string): Promise<void> {
    let envelope: RelayEnvelope;
    try { envelope = JSON.parse(raw) as RelayEnvelope } catch { return }
    if (envelope.type !== 'tool-call') return;
    const call = envelope;
    if (call.action === 'cancel') {
      this.calls.get(call.requestId)?.abort();
      this.calls.delete(call.requestId);
      return;
    }
    const error = await this.validateCall(call);
    if (error) {
      this.send({ type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId, error });
      return;
    }
    const controller = new AbortController();
    this.calls.set(call.requestId, controller);
    const startedAt = Date.now();
    const delay = Math.max(0, call.deadlineAt! - startedAt);
    let timedOut = false;
    let rejectDeadline: (error: Error) => void = () => undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectDeadline(new Error('deadline'));
    }, delay);
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const execution = this.options.execute(call.ctx!, call.category!, call.tool!, call.args, controller.signal);
    execution.then(result => {
      if (!timedOut && !controller.signal.aborted) return;
      const late = this.lateResults.record(call.requestId, result);
      this.options.log?.warn(`[RelayToolTunnel] Late tool result for ${ call.requestId }: ${ late.outcome }`);
    }, error => {
      if (!timedOut && !controller.signal.aborted) return;
      const late = this.lateResults.record(call.requestId, undefined, error);
      this.options.log?.warn(`[RelayToolTunnel] Late tool result for ${ call.requestId }: ${ late.outcome }`);
    });
    try {
      const result = await Promise.race([execution, deadline]);
      this.send({ type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId, result });
    } catch (cause) {
      timedOut = timedOut || controller.signal.aborted || Date.now() >= call.deadlineAt!;
      const elapsedMs = Date.now() - startedAt;
      const operationTypes = call.operationTypes ?? this.options.operationTypes?.(call.category!, call.tool!) ?? [];
      this.send({
        type:      'tool-result',
        requestId: call.requestId,
        deviceId:  call.deviceId,
        error:     timedOut
          ? {
            code: 'DEADLINE_EXCEEDED', message: 'Desktop tool call deadline exceeded', retryable: true,
            details: this.deadlinePolicy.timeoutDetails(call.tool!, delay, elapsedMs, operationTypes),
          }
          : { code: 'INTERNAL', message: cause instanceof Error ? cause.message : String(cause) },
      });
    } finally {
      clearTimeout(timer);
      this.calls.delete(call.requestId);
    }
  }

  private async validateCall(call: RelayToolCallEnvelope): Promise<RelayError | null> {
    if (!call.ctx || !call.category || !call.tool || !call.deadlineAt) {
      return { code: 'BAD_REQUEST', message: 'Incomplete tool-call envelope' };
    }
    if (call.deadlineAt <= Date.now()) {
      const deadlineMs = this.deadlinePolicy.deadlineMs(call.tool, call.operationTypes ?? this.options.operationTypes?.(call.category, call.tool));
      return {
        code: 'DEADLINE_EXCEEDED', message: 'Desktop tool call deadline exceeded', retryable: true,
        details: this.deadlinePolicy.timeoutDetails(
          call.tool,
          deadlineMs,
          deadlineMs + (Date.now() - call.deadlineAt),
          call.operationTypes ?? this.options.operationTypes?.(call.category, call.tool),
        ),
      };
    }
    if (call.ctx.device_id && call.ctx.device_id !== call.deviceId) {
      return { code: 'FORBIDDEN', message: 'Tool capability is bound to a different Desktop device' };
    }
    return validateRelayToolCallUser(call.ctx, await this.options.currentUserId());
  }

  private send(envelope: RelayEnvelope): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(envelope));
  }
}
