// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import https from 'node:https';

import NodeWebSocket, { type RawData } from 'ws';

import { pinnedLookup } from '../pinnedLookup.js';
import { BaseRelaySession } from './BaseRelaySession.js';
import {
  BASE64_PATTERN, BOOTSTRAP_TIMEOUT_MS, GATEWAY_SESSION_ID, MAX_AUDIO_CHUNK_BYTES, MAX_AUDIO_COMMAND_BYTES,
  MAX_COMMAND_BYTES, MAX_GATEWAY_BUFFERED_BYTES, MAX_QUEUE_EVENTS,
} from './RelayLimits.js';
import { RelayPayloadCodec } from './RelayPayloadCodec.js';

import type { BrokerRelaySendRequest } from '../contracts.js';

export class EnterpriseGatewayRelaySession extends BaseRelaySession {
  private readonly gatewayOrigin: string;
  private readonly gatewayAgent: https.Agent;
  private lobbySocket:   NodeWebSocket | null = null;
  private sessionSocket: NodeWebSocket | null = null;
  private audioSocket:   NodeWebSocket | null = null;
  private sessionId:     string | null = null;
  private audioSessionId: string | null = null;
  private readonly pendingAcks = new Map<string, NodeWebSocket>();
  private healthTimer: NodeJS.Timeout | null = null;
  private sessionReconnectTimer: NodeJS.Timeout | null = null;
  private audioReconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    relayId: string, credential: string, gatewayUrl: string,
    gatewayAddress: { address: string; family: 4 | 6 } | undefined,
    abortSignal: AbortSignal,
  ) {
    super(relayId, 'enterprise.gateway', credential, abortSignal);
    const target = new URL(gatewayUrl);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) {
      throw new Error('relay_destination_denied');
    }
    this.gatewayOrigin = target.origin;
    if (!gatewayAddress) throw new Error('relay_destination_denied');
    this.gatewayAgent = new https.Agent({
      lookup: pinnedLookup(gatewayAddress.address, gatewayAddress.family),
    });
  }

  async start(): Promise<void> {
    await this.connectLobby();
  }

  async send(command: BrokerRelaySendRequest): Promise<void> {
    const commandLimit = command.type === 'gateway.audio.chunk' ? MAX_AUDIO_COMMAND_BYTES : MAX_COMMAND_BYTES;
    if (RelayPayloadCodec.jsonBytes(command) > commandLimit) throw new Error('relay_command_too_large');
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
    this.gatewayAgent.destroy();
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
    const socket = new NodeWebSocket(url, { agent: this.gatewayAgent, headers: { authorization: `Bearer ${ this.credential }` } });
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
    const socket = new NodeWebSocket(url, { agent: this.gatewayAgent });
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
    const socket = new NodeWebSocket(this.websocketUrl(`/ws/audio/${ encodeURIComponent(sessionId) }`), { agent: this.gatewayAgent });
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
