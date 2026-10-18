import WebSocket from 'ws';

import type {
  RelayEnvelope, RelayError, RelayToolCallEnvelope, RelayToolExecutionContext, RelayToolResult,
} from './relayProtocol.js';

const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;

export interface RelayToolTunnelOptions {
  relayUrl:      string;
  deviceToken:   string | (() => string | Promise<string>);
  deviceId:      () => Promise<string>;
  currentUserId: () => Promise<string>;
  execute:       (ctx: RelayToolExecutionContext, category: string, tool: string, args: unknown, signal: AbortSignal) => Promise<RelayToolResult>;
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
  private socket:         WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = BASE_RECONNECT_MS;
  private running = false;
  private calls = new Map<string, AbortController>();

  constructor(private readonly options: RelayToolTunnelOptions) {}

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
    const delay = Math.max(0, call.deadlineAt! - Date.now());
    const timer = setTimeout(() => controller.abort(), delay);
    try {
      const result = await this.options.execute(call.ctx!, call.category!, call.tool!, call.args, controller.signal);
      if (!controller.signal.aborted) this.send({ type: 'tool-result', requestId: call.requestId, deviceId: call.deviceId, result });
    } catch (cause) {
      const timedOut = controller.signal.aborted || Date.now() >= call.deadlineAt!;
      this.send({
        type:      'tool-result',
        requestId: call.requestId,
        deviceId:  call.deviceId,
        error:     timedOut
          ? { code: 'DEADLINE_EXCEEDED', message: 'Desktop tool call deadline exceeded', retryable: true }
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
    if (call.deadlineAt <= Date.now()) return { code: 'DEADLINE_EXCEEDED', message: 'Desktop tool call deadline exceeded', retryable: true };
    if (call.ctx.device_id && call.ctx.device_id !== call.deviceId) {
      return { code: 'FORBIDDEN', message: 'Tool capability is bound to a different Desktop device' };
    }
    return validateRelayToolCallUser(call.ctx, await this.options.currentUserId());
  }

  private send(envelope: RelayEnvelope): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(envelope));
  }
}
