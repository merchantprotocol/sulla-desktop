import { randomUUID } from 'node:crypto';

import NodeWebSocket, { type RawData } from 'ws';

import type { BrokerRelaySendRequest } from './contracts.js';

export type VaultRelayOperation = 'slack.socket-mode' | 'discord.gateway' | 'enterprise.gateway';

export interface VaultRelayOpenRequest {
  relayId:     string;
  operation:   VaultRelayOperation;
  /** Plaintext is accepted only inside the vault process and is never emitted or logged. */
  credential:  string;
  /** Decrypted routing metadata accepted only for the typed enterprise relay. */
  gatewayUrl?: string;
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
const MAX_BOOTSTRAP_BYTES = 64 * 1024;
const BOOTSTRAP_TIMEOUT_MS = 10_000;
const RECONNECT_MAX_MS = 30_000;
const SENSITIVE_KEY = /(?:^|_)(?:token|authorization|cookie|password|secret|session_key|session_id|resume_gateway_url|response_url)(?:$|_)/i;
const SLACK_SOCKET_HOSTS = new Set(['wss-primary.slack.com', 'wss-backup.slack.com']);
const GATEWAY_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
const MAX_AUDIO_COMMAND_BYTES = 90 * 1024;
const MAX_GATEWAY_BUFFERED_BYTES = 256 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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

function assertDiscordGateway(value: string): URL {
  const url = new URL(value);
  const providerHost = url.hostname === 'gateway.discord.gg' || url.hostname.endsWith('.discord.gg');
  if (url.protocol !== 'wss:' || !providerHost || url.username || url.password) {
    throw new Error('relay_destination_denied');
  }
  return url;
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BOOTSTRAP_BYTES) {
      await reader.cancel();
      throw new Error('relay_bootstrap_too_large');
    }
    chunks.push(value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
    protected readonly authoritySignal: AbortSignal,
  ) {
    this.sensitiveValues.add(credential);
    this.output = new RelayEventQueue(() => this.sensitiveValues);
    this.expiryTimer = setTimeout(() => this.close('expired'), SESSION_TTL_MS);
    this.expiryTimer.unref?.();
    if (authoritySignal.aborted) {
      this.close('authority_aborted');
      throw new Error('authority_aborted');
    }
    authoritySignal.addEventListener('abort', () => this.close('authority_aborted'), { once: true });
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
    const byteLength = typeof data === 'string'
      ? Buffer.byteLength(data)
      : data instanceof ArrayBuffer
        ? data.byteLength
        : ArrayBuffer.isView(data)
          ? data.byteLength
          : MAX_EVENT_BYTES + 1;
    if (byteLength > MAX_EVENT_BYTES) throw new Error('relay_frame_too_large');
    try {
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
      method:   'POST',
      headers:  { authorization: `Bearer ${ this.credential }`, 'content-type': 'application/x-www-form-urlencoded' },
      body:     '',
      redirect: 'error',
      signal:   AbortSignal.any([this.authoritySignal, AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS)]),
    });
    const body = await readBoundedJson(response).catch(() => null) as { ok?: boolean; url?: string } | null;
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
      headers:  { authorization: `Bot ${ this.credential }` },
      redirect: 'error',
      signal:   AbortSignal.any([this.authoritySignal, AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS)]),
    });
    const body = await readBoundedJson(response).catch(() => null) as { url?: string } | null;
    if (!response.ok || typeof body?.url !== 'string') {
      throw new Error('discord_relay_connect_failed');
    }
    this.gatewayUrl = assertDiscordGateway(body.url).toString();
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
        this.resumeUrl = assertDiscordGateway(frame.d.resume_gateway_url).toString();
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

class EnterpriseGatewayRelaySession extends BaseRelaySession {
  private readonly gatewayOrigin: string;
  private lobbySocket:   NodeWebSocket | null = null;
  private sessionSocket: NodeWebSocket | null = null;
  private audioSocket:   NodeWebSocket | null = null;
  private sessionId:     string | null = null;
  private audioSessionId: string | null = null;
  private readonly pendingAcks = new Map<string, NodeWebSocket>();
  private healthTimer: NodeJS.Timeout | null = null;
  private sessionReconnectTimer: NodeJS.Timeout | null = null;
  private audioReconnectTimer: NodeJS.Timeout | null = null;

  constructor(relayId: string, credential: string, gatewayUrl: string, abortSignal: AbortSignal) {
    super(relayId, 'enterprise.gateway', credential, abortSignal);
    const target = new URL(gatewayUrl);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) {
      throw new Error('relay_destination_denied');
    }
    this.gatewayOrigin = target.origin;
  }

  async start(): Promise<void> {
    await this.connectLobby();
  }

  async send(command: BrokerRelaySendRequest): Promise<void> {
    const commandLimit = command.type === 'gateway.audio.chunk' ? MAX_AUDIO_COMMAND_BYTES : MAX_COMMAND_BYTES;
    if (jsonBytes(command) > commandLimit) throw new Error('relay_command_too_large');
    const payload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
      ? command.payload as Record<string, unknown>
      : {};
    if (command.type === 'gateway.capabilities') {
      this.sendJson(this.lobbySocket, { event_type: 'capabilities', reliable_delivery: true });
      return;
    }
    if (command.type === 'gateway.ack') {
      const messageId = typeof payload._msg_id === 'string' ? payload._msg_id : '';
      const socket = this.pendingAcks.get(messageId);
      if (!socket) throw new Error('relay_ack_not_pending');
      this.sendJson(socket, { event_type: 'ack', _msg_id: messageId });
      this.pendingAcks.delete(messageId);
      return;
    }
    const sessionId = this.requireSessionId(payload.sessionId);
    if (command.type === 'gateway.session.open') {
      this.sessionId = sessionId;
      await this.connectSession(sessionId);
      return;
    }
    if (command.type === 'gateway.session.close') {
      if (this.sessionId !== sessionId) throw new Error('relay_command_invalid');
      this.sessionId = null;
      this.clearSessionReconnect();
      this.sessionSocket?.close(1000, 'session_closed');
      this.sessionSocket = null;
      return;
    }
    if (command.type === 'gateway.audio.open') {
      this.audioSessionId = sessionId;
      await this.connectAudio(sessionId);
      return;
    }
    if (command.type === 'gateway.audio.close') {
      if (this.audioSessionId !== sessionId) throw new Error('relay_command_invalid');
      this.audioSessionId = null;
      this.clearAudioReconnect();
      this.audioSocket?.close(1000, 'audio_closed');
      this.audioSocket = null;
      return;
    }
    if (command.type === 'gateway.audio.chunk') {
      if (this.audioSessionId !== sessionId || this.audioSocket?.readyState !== NodeWebSocket.OPEN) {
        throw new Error('relay_not_connected');
      }
      const channel = Number(payload.channel ?? 0);
      if (!Number.isSafeInteger(channel) || channel < 0 || channel > 255 || typeof payload.data !== 'string') {
        throw new Error('relay_command_invalid');
      }
      if (!BASE64_PATTERN.test(payload.data)) throw new Error('relay_command_invalid');
      const audio = Buffer.from(payload.data, 'base64');
      if (audio.byteLength > MAX_AUDIO_CHUNK_BYTES || audio.toString('base64') !== payload.data) {
        throw new Error('relay_command_invalid');
      }
      if (this.audioSocket.bufferedAmount > MAX_GATEWAY_BUFFERED_BYTES) throw new Error('relay_backpressure');
      if (channel === 0) this.audioSocket.send(audio, { binary: true });
      else this.audioSocket.send(Buffer.concat([Buffer.from([0x01, channel]), audio]), { binary: true });
      return;
    }
    throw new Error('relay_command_denied');
  }

  override close(reason?: string): void {
    this.clearHealthTimer();
    this.clearSessionReconnect();
    this.clearAudioReconnect();
    this.pendingAcks.clear();
    this.lobbySocket?.close(1000, 'relay_closed');
    this.sessionSocket?.close(1000, 'relay_closed');
    this.audioSocket?.close(1000, 'relay_closed');
    this.lobbySocket = null;
    this.sessionSocket = null;
    this.audioSocket = null;
    this.sessionId = null;
    this.audioSessionId = null;
    super.close(reason);
  }

  protected onOpen(_socket: WebSocket): void {}
  protected onMessage(_socket: WebSocket, _data: unknown): void {}

  protected async reconnect(): Promise<void> {
    if (!this.closed) await this.connectLobby();
  }

  private async connectLobby(): Promise<void> {
    const url = this.websocketUrl('/ws/listener');
    url.searchParams.set('appName', 'SullaDesktop');
    url.searchParams.set('appVersion', '1.0.0');
    url.searchParams.set('hostname', 'sulla-desktop');
    const socket = new NodeWebSocket(url, { headers: { authorization: `Bearer ${ this.credential }` } });
    this.lobbySocket = socket;
    await this.awaitOpen(socket);
    this.sendJson(socket, { event_type: 'capabilities', reliable_delivery: true });
    this.resetHealthTimer();
    socket.on('message', data => this.handleGatewayMessage('gateway.lobby', socket, data));
    socket.on('close', () => {
      if (this.lobbySocket === socket) this.lobbySocket = null;
      this.clearHealthTimer();
      if (!this.closed) this.onDisconnect(0);
    });
    socket.on('error', () => socket.close());
  }

  private async connectSession(sessionId: string): Promise<void> {
    this.clearSessionReconnect();
    this.sessionSocket?.close(1000, 'session_replaced');
    const url = this.websocketUrl(`/ws/listener/${ encodeURIComponent(sessionId) }`);
    url.searchParams.set('apiKey', this.credential);
    this.sensitiveValues.add(url.toString());
    const socket = new NodeWebSocket(url);
    this.sessionSocket = socket;
    await this.awaitOpen(socket);
    this.sendJson(socket, { event_type: 'capabilities', reliable_delivery: true });
    socket.on('message', data => this.handleGatewayMessage('gateway.session', socket, data));
    socket.on('close', () => {
      if (this.sessionSocket === socket) this.sessionSocket = null;
      if (!this.closed && this.sessionId === sessionId) this.scheduleSessionReconnect(sessionId);
    });
    socket.on('error', () => socket.close());
  }

  private async connectAudio(sessionId: string): Promise<void> {
    this.clearAudioReconnect();
    this.audioSocket?.close(1000, 'audio_replaced');
    const socket = new NodeWebSocket(this.websocketUrl(`/ws/audio/${ encodeURIComponent(sessionId) }`));
    this.audioSocket = socket;
    await this.awaitOpen(socket);
    this.output.push('gateway.audio.open', { sessionId });
    socket.on('message', data => this.handleGatewayMessage('gateway.audio', socket, data));
    socket.on('close', () => {
      if (this.audioSocket === socket) this.audioSocket = null;
      if (!this.closed && this.audioSessionId === sessionId) this.scheduleAudioReconnect(sessionId);
    });
    socket.on('error', () => socket.close());
  }

  private handleGatewayMessage(type: string, socket: NodeWebSocket, data: RawData): void {
    let frame: Record<string, any> | null;
    try {
      frame = this.parse(data);
    } catch {
      socket.close(1009, 'invalid_frame');
      return;
    }
    if (!frame) return;
    if (socket === this.lobbySocket) this.resetHealthTimer();
    if (typeof frame._msg_id === 'string' && frame._msg_id) {
      if (this.pendingAcks.size >= MAX_QUEUE_EVENTS) {
        this.output.push('relay.gap', { reason: 'ack_overflow' });
        socket.close(1013, 'ack_overflow');
        return;
      }
      this.pendingAcks.set(frame._msg_id, socket);
    }
    this.output.push(type, frame);
  }

  private sendJson(socket: NodeWebSocket | null, value: Record<string, unknown>): void {
    if (socket?.readyState !== NodeWebSocket.OPEN) throw new Error('relay_not_connected');
    socket.send(JSON.stringify(value));
  }

  private awaitOpen(socket: NodeWebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error('relay_connect_timeout'));
      }, BOOTSTRAP_TIMEOUT_MS);
      timeout.unref?.();
      socket.once('open', () => { clearTimeout(timeout); resolve() });
      socket.once('error', () => { clearTimeout(timeout); reject(new Error('relay_connect_failed')) });
    });
  }

  private websocketUrl(path: string): URL {
    const url = new URL(this.gatewayOrigin);
    url.protocol = 'wss:';
    url.pathname = path;
    return url;
  }

  private requireSessionId(value: unknown): string {
    if (typeof value !== 'string' || !GATEWAY_SESSION_ID.test(value)) throw new Error('relay_command_invalid');
    return value;
  }

  private resetHealthTimer(): void {
    this.clearHealthTimer();
    this.healthTimer = setTimeout(() => this.lobbySocket?.terminate(), 45_000);
    this.healthTimer.unref?.();
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = null;
  }

  private scheduleSessionReconnect(sessionId: string): void {
    this.clearSessionReconnect();
    this.sessionReconnectTimer = setTimeout(() => {
      this.sessionReconnectTimer = null;
      if (this.sessionId === sessionId) this.connectSession(sessionId).catch(() => this.scheduleSessionReconnect(sessionId));
    }, 2_000);
    this.sessionReconnectTimer.unref?.();
  }

  private clearSessionReconnect(): void {
    if (this.sessionReconnectTimer) clearTimeout(this.sessionReconnectTimer);
    this.sessionReconnectTimer = null;
  }

  private scheduleAudioReconnect(sessionId: string): void {
    this.clearAudioReconnect();
    this.audioReconnectTimer = setTimeout(() => {
      this.audioReconnectTimer = null;
      if (this.audioSessionId === sessionId) this.connectAudio(sessionId).catch(() => this.scheduleAudioReconnect(sessionId));
    }, 2_000);
    this.audioReconnectTimer.unref?.();
  }

  private clearAudioReconnect(): void {
    if (this.audioReconnectTimer) clearTimeout(this.audioReconnectTimer);
    this.audioReconnectTimer = null;
  }
}

export class DefaultVaultRelayManager implements VaultRelayManager {
  private readonly sessions = new Map<string, RelaySession>();

  async open(request: VaultRelayOpenRequest): Promise<VaultRelayHandle> {
    if (!request.relayId || !request.credential || request.abortSignal.aborted) throw new Error('invalid_relay_request');
    if (this.sessions.has(request.relayId)) throw new Error('relay_already_exists');
    const session: RelaySession = request.operation === 'slack.socket-mode'
      ? new SlackRelaySession(request.relayId, request.credential, request.abortSignal)
      : request.operation === 'discord.gateway'
        ? new DiscordRelaySession(request.relayId, request.credential, request.abortSignal)
        : new EnterpriseGatewayRelaySession(
          request.relayId,
          request.credential,
          request.gatewayUrl ?? '',
          request.abortSignal,
        );
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
