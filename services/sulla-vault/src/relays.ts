import { randomUUID } from 'node:crypto';

import type { BrokerRelaySendRequest } from './contracts.js';

export type VaultRelayOperation = 'slack.socket-mode' | 'discord.gateway';

export interface VaultRelayOpenRequest {
  relayId:     string;
  operation:   VaultRelayOperation;
  /** Plaintext is accepted only inside the vault process and is never emitted or logged. */
  credential:  string;
  abortSignal: AbortSignal;
}

export interface VaultRelayEvent {
  sequence: number;
  type:     string;
  payload:  unknown;
}

export interface VaultRelayHandle {
  relayId:   string;
  expiresAt: number;
}

export interface VaultRelayManager {
  open(request: VaultRelayOpenRequest): Promise<VaultRelayHandle>;
  events(relayId: string, signal: AbortSignal): AsyncIterable<VaultRelayEvent>;
  send(relayId: string, command: BrokerRelaySendRequest): Promise<void>;
  close(relayId: string, reason?: string): void;
  closeAll(reason?: string): void;
}

interface RelaySession {
  readonly relayId:   string;
  readonly expiresAt: number;
  readonly operation: VaultRelayOperation;
  events(signal: AbortSignal): AsyncIterable<VaultRelayEvent>;
  send(command: BrokerRelaySendRequest): Promise<void>;
  close(reason?: string): void;
}

const SESSION_TTL_MS = 30 * 60_000;
const MAX_QUEUE_EVENTS = 512;
const MAX_EVENT_BYTES = 512 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024;
const RECONNECT_MAX_MS = 30_000;
const SENSITIVE_KEY = /(?:^|_)(?:token|authorization|cookie|password|secret|session_key|session_id|resume_gateway_url|response_url)(?:$|_)/i;
const SLACK_SOCKET_HOSTS = new Set(['wss-primary.slack.com', 'wss-backup.slack.com']);
const DISCORD_GATEWAY_HOSTS = new Set(['gateway.discord.gg']);

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function redactText(value: string, sensitiveValues: Iterable<string>): string {
  let output = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length >= 4) output = output.split(sensitiveValue).join('[redacted]');
  }
  return output;
}

function sanitized(value: unknown, sensitiveValues: Iterable<string> = [], depth = 0): unknown {
  if (depth > 12) return '[depth-limited]';
  if (typeof value === 'string') return redactText(value, sensitiveValues);
  if (Array.isArray(value)) return value.slice(0, 2_000).map(entry => sanitized(entry, sensitiveValues, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    output[key] = sanitized(entry, sensitiveValues, depth + 1);
  }
  return output;
}

function assertProviderWebSocket(value: string, allowedHosts: ReadonlySet<string>): URL {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || !allowedHosts.has(url.hostname) || url.username || url.password) {
    throw new Error('relay_destination_denied');
  }
  return url;
}

class RelayEventQueue {
  private readonly queue: VaultRelayEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private nextSequence = 1;

  constructor(private readonly sensitiveValues: () => Iterable<string>) {}

  push(type: string, payload: unknown): number {
    if (this.closed) return 0;
    const safePayload = sanitized(payload, this.sensitiveValues());
    if (jsonBytes(safePayload) > MAX_EVENT_BYTES) throw new Error('relay_event_too_large');
    if (this.queue.length >= MAX_QUEUE_EVENTS) {
      this.queue.length = 0;
      this.queue.push({
        sequence: this.nextSequence++,
        type:     'relay.gap',
        payload:  { reason: 'queue_overflow' },
      });
    }
    const sequence = this.nextSequence++;
    this.queue.push({ sequence, type, payload: safePayload });
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    return sequence;
  }

  end(): void {
    this.closed = true;
    this.queue.length = 0;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  async * iterate(signal: AbortSignal): AsyncIterable<VaultRelayEvent> {
    while (!signal.aborted) {
      const event = this.queue.shift();
      if (event) {
        yield event;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>(resolve => {
        const wake = () => {
          signal.removeEventListener('abort', wake);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
  }
}

abstract class BaseRelaySession implements RelaySession {
  readonly expiresAt = Date.now() + SESSION_TTL_MS;
  protected readonly sensitiveValues = new Set<string>();
  protected readonly output: RelayEventQueue;
  protected socket:          WebSocket | null = null;
  protected closed = false;
  protected reconnectAttempt = 0;
  protected reconnectTimer:  NodeJS.Timeout | null = null;
  protected expiryTimer:     NodeJS.Timeout;

  constructor(
    readonly relayId: string,
    readonly operation: VaultRelayOperation,
    protected credential: string,
    abortSignal: AbortSignal,
  ) {
    this.sensitiveValues.add(credential);
    this.output = new RelayEventQueue(() => this.sensitiveValues);
    abortSignal.addEventListener('abort', () => this.close('authority_aborted'), { once: true });
    this.expiryTimer = setTimeout(() => this.close('expired'), SESSION_TTL_MS);
    this.expiryTimer.unref?.();
  }

  events(signal: AbortSignal): AsyncIterable<VaultRelayEvent> {
    return this.output.iterate(signal);
  }

  abstract start(): Promise<void>;
  abstract send(command: BrokerRelaySendRequest): Promise<void>;

  close(_reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiryTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'relay_closed');
    this.socket = null;
    this.credential = '';
    this.output.end();
    this.sensitiveValues.clear();
  }

  protected connect(url: string): WebSocket {
    if (this.closed) throw new Error('relay_closed');
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.onOpen(socket);
    });
    socket.addEventListener('message', event => {
      try {
        this.onMessage(socket, event.data);
      } catch {
        socket.close(1009, 'invalid_frame');
      }
    });
    socket.addEventListener('close', event => {
      if (this.socket === socket) this.socket = null;
      if (!this.closed) this.onDisconnect(event.code);
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) socket.close();
    });
    this.socket = socket;
    return socket;
  }

  protected abstract onOpen(socket: WebSocket): void;
  protected abstract onMessage(socket: WebSocket, data: unknown): void;
  protected abstract reconnect(): Promise<void>;

  protected onDisconnect(_code: number): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt++, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnect().catch(() => this.onDisconnect(0));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  protected parse(data: unknown): Record<string, any> | null {
    try {
      const byteLength = typeof data === 'string'
        ? Buffer.byteLength(data)
        : data instanceof ArrayBuffer
          ? data.byteLength
          : ArrayBuffer.isView(data)
            ? data.byteLength
            : MAX_EVENT_BYTES + 1;
      if (byteLength > MAX_EVENT_BYTES) throw new Error('relay_frame_too_large');
      const text = typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
            : '';
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
}

class SlackRelaySession extends BaseRelaySession {
  private readonly acknowledgements = new Map<number, { envelopeId: string; timer: NodeJS.Timeout }>();

  constructor(relayId: string, credential: string, abortSignal: AbortSignal) {
    super(relayId, 'slack.socket-mode', credential, abortSignal);
  }

  async start(): Promise<void> {
    await this.reconnect();
  }

  send(command: BrokerRelaySendRequest): Promise<void> {
    if (jsonBytes(command) > MAX_COMMAND_BYTES) throw new Error('relay_command_too_large');
    if (command.type !== 'slack.ack' || !Number.isSafeInteger(command.sequence)) {
      throw new Error('relay_command_denied');
    }
    const pending = this.acknowledgements.get(command.sequence!);
    if (!pending || this.socket?.readyState !== WebSocket.OPEN) throw new Error('relay_ack_not_pending');
    const responsePayload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
      ? sanitized(command.payload, this.sensitiveValues)
      : undefined;
    this.socket.send(JSON.stringify({ envelope_id: pending.envelopeId, ...(responsePayload ? { payload: responsePayload } : {}) }));
    clearTimeout(pending.timer);
    this.acknowledgements.delete(command.sequence!);
    return Promise.resolve();
  }

  override close(reason?: string): void {
    for (const pending of this.acknowledgements.values()) clearTimeout(pending.timer);
    this.acknowledgements.clear();
    super.close(reason);
  }

  protected onOpen(_socket: WebSocket): void {}

  protected onMessage(socket: WebSocket, data: unknown): void {
    const frame = this.parse(data);
    if (!frame || typeof frame.envelope_id !== 'string' || !frame.envelope_id) return;
    const sequence = this.output.push(`slack.${ String(frame.type || 'event') }`, frame.payload ?? {});
    const timer = setTimeout(() => {
      const pending = this.acknowledgements.get(sequence);
      if (!pending || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ envelope_id: pending.envelopeId }));
      this.acknowledgements.delete(sequence);
    }, 2_500);
    timer.unref?.();
    this.acknowledgements.set(sequence, { envelopeId: frame.envelope_id, timer });
  }

  protected async reconnect(): Promise<void> {
    if (this.closed) return;
    const response = await fetch('https://slack.com/api/apps.connections.open', {
      method:  'POST',
      headers: { authorization: `Bearer ${ this.credential }`, 'content-type': 'application/x-www-form-urlencoded' },
      body:    '',
    });
    const body = await response.json().catch(() => null) as { ok?: boolean; url?: string } | null;
    if (!response.ok || !body?.ok || typeof body.url !== 'string') {
      throw new Error('slack_relay_connect_failed');
    }
    const socketUrl = assertProviderWebSocket(body.url, SLACK_SOCKET_HOSTS);
    this.sensitiveValues.add(socketUrl.toString());
    for (const value of socketUrl.searchParams.values()) this.sensitiveValues.add(value);
    this.connect(socketUrl.toString());
  }
}

interface DiscordGatewayFrame { op?: number; d?: any; s?: number | null; t?: string | null }

class DiscordRelaySession extends BaseRelaySession {
  private gatewayUrl = 'wss://gateway.discord.gg';
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatAcked = true;
  private lastSequence:   number | null = null;
  private sessionId:      string | null = null;
  private resumeUrl:      string | null = null;

  constructor(relayId: string, credential: string, abortSignal: AbortSignal) {
    super(relayId, 'discord.gateway', credential, abortSignal);
  }

  async start(): Promise<void> {
    const response = await fetch('https://discord.com/api/v10/gateway/bot', {
      headers: { authorization: `Bot ${ this.credential }` },
    });
    const body = await response.json().catch(() => null) as { url?: string } | null;
    if (!response.ok || typeof body?.url !== 'string') {
      throw new Error('discord_relay_connect_failed');
    }
    this.gatewayUrl = assertProviderWebSocket(body.url, DISCORD_GATEWAY_HOSTS).toString();
    await this.reconnect();
  }

  send(command: BrokerRelaySendRequest): Promise<void> {
    if (jsonBytes(command) > MAX_COMMAND_BYTES) throw new Error('relay_command_too_large');
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('relay_not_connected');
    if (command.type === 'discord.presence') {
      const source = command.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {};
      const status = ['online', 'dnd', 'idle', 'invisible', 'offline'].includes(String(source.status)) ? source.status : 'online';
      this.socket.send(JSON.stringify({
        op: 3,
        d:  {
          since:      typeof source.since === 'number' ? source.since : null,
          activities: Array.isArray(source.activities) ? sanitized(source.activities, this.sensitiveValues) : [],
          status,
          afk:        source.afk === true,
        },
      }));
      return Promise.resolve();
    }
    if (command.type === 'discord.voice-state') {
      const source = command.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {};
      if (typeof source.guild_id !== 'string') throw new Error('relay_command_invalid');
      this.socket.send(JSON.stringify({
        op: 4,
        d:  {
          guild_id:   source.guild_id,
          channel_id: typeof source.channel_id === 'string' ? source.channel_id : null,
          self_mute:  source.self_mute === true,
          self_deaf:  source.self_deaf === true,
        },
      }));
      return Promise.resolve();
    }
    throw new Error('relay_command_denied');
  }

  override close(reason?: string): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    super.close(reason);
  }

  protected onOpen(_socket: WebSocket): void {}

  protected onMessage(socket: WebSocket, data: unknown): void {
    const frame = this.parse(data) as DiscordGatewayFrame | null;
    if (!frame || typeof frame.op !== 'number') return;
    if (typeof frame.s === 'number') this.lastSequence = frame.s;
    if (frame.op === 10) {
      this.startHeartbeat(socket, Number(frame.d?.heartbeat_interval));
      this.authenticate(socket);
      return;
    }
    if (frame.op === 11) {
      this.heartbeatAcked = true;
      return;
    }
    if (frame.op === 1) {
      this.sendHeartbeat(socket);
      return;
    }
    if (frame.op === 7) {
      socket.close(4000, 'reconnect');
      return;
    }
    if (frame.op === 9) {
      if (frame.d !== true) {
        this.sessionId = null;
        this.lastSequence = null;
      }
      socket.close(4000, 'invalid_session');
      return;
    }
    if (frame.op !== 0 || typeof frame.t !== 'string') return;
    if (frame.t === 'READY') {
      if (typeof frame.d?.session_id === 'string') {
        this.sessionId = frame.d.session_id;
        this.sensitiveValues.add(frame.d.session_id);
      }
      if (typeof frame.d?.resume_gateway_url === 'string') {
        this.resumeUrl = assertProviderWebSocket(frame.d.resume_gateway_url, DISCORD_GATEWAY_HOSTS).toString();
      }
    }
    this.output.push(`discord.${ frame.t.toLowerCase() }`, frame.d ?? {});
  }

  protected reconnect(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const base = this.resumeUrl ?? this.gatewayUrl;
    this.connect(`${ base.replace(/\/$/, '') }/?v=10&encoding=json`);
    return Promise.resolve();
  }

  private authenticate(socket: WebSocket): void {
    if (this.sessionId && this.lastSequence !== null) {
      socket.send(JSON.stringify({
        op: 6,
        d:  {
          token:      this.credential,
          session_id: this.sessionId,
          seq:        this.lastSequence,
        },
      }));
      return;
    }
    socket.send(JSON.stringify({
      op: 2,
      d:  {
        token:      this.credential,
        intents:    33281,
        properties: { os: process.platform, browser: 'sulla-vault', device: 'sulla-vault' },
      },
    }));
  }

  private startHeartbeat(socket: WebSocket, intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs < 1_000) {
      socket.close(4000, 'invalid_heartbeat');
      return;
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(socket), intervalMs);
    this.heartbeatTimer.unref?.();
    setTimeout(() => this.sendHeartbeat(socket), Math.floor(Math.random() * intervalMs)).unref?.();
  }

  private sendHeartbeat(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!this.heartbeatAcked) {
      socket.close(4000, 'heartbeat_timeout');
      return;
    }
    this.heartbeatAcked = false;
    socket.send(JSON.stringify({ op: 1, d: this.lastSequence }));
  }
}

export class DefaultVaultRelayManager implements VaultRelayManager {
  private readonly sessions = new Map<string, RelaySession>();

  async open(request: VaultRelayOpenRequest): Promise<VaultRelayHandle> {
    if (!request.relayId || !request.credential || request.abortSignal.aborted) throw new Error('invalid_relay_request');
    if (this.sessions.has(request.relayId)) throw new Error('relay_already_exists');
    const session: RelaySession = request.operation === 'slack.socket-mode'
      ? new SlackRelaySession(request.relayId, request.credential, request.abortSignal)
      : new DiscordRelaySession(request.relayId, request.credential, request.abortSignal);
    this.sessions.set(request.relayId, session);
    try {
      await (session as BaseRelaySession).start();
      return { relayId: request.relayId, expiresAt: session.expiresAt };
    } catch (error) {
      session.close('open_failed');
      this.sessions.delete(request.relayId);
      throw error;
    }
  }

  events(relayId: string, signal: AbortSignal): AsyncIterable<VaultRelayEvent> {
    return this.require(relayId).events(signal);
  }

  send(relayId: string, command: BrokerRelaySendRequest): Promise<void> {
    return this.require(relayId).send(command);
  }

  close(relayId: string, reason?: string): void {
    const session = this.sessions.get(relayId);
    if (!session) return;
    this.sessions.delete(relayId);
    session.close(reason);
  }

  closeAll(reason?: string): void {
    for (const relayId of [...this.sessions.keys()]) this.close(relayId, reason);
  }

  private require(relayId: string): RelaySession {
    const session = this.sessions.get(relayId);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.close(relayId, 'expired');
      throw new Error('relay_not_found');
    }
    return session;
  }
}

export function createRelayId(): string {
  return randomUUID();
}
