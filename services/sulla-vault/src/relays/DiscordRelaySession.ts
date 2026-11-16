// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseRelaySession } from './BaseRelaySession.js';
import { RelayBootstrapReader } from './RelayBootstrapReader.js';
import { RelayDestinationPolicy } from './RelayDestinationPolicy.js';
import { BOOTSTRAP_TIMEOUT_MS, MAX_COMMAND_BYTES } from './RelayLimits.js';
import { RelayPayloadCodec } from './RelayPayloadCodec.js';

import type { BrokerRelaySendRequest } from '../contracts.js';

interface DiscordGatewayFrame { op?: number; d?: any; s?: number | null; t?: string | null }

export class DiscordRelaySession extends BaseRelaySession {
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
    const body = await RelayBootstrapReader.readBoundedJson(response).catch(() => null) as { url?: string } | null;
    if (!response.ok || typeof body?.url !== 'string') {
      throw new Error('discord_relay_connect_failed');
    }
    this.gatewayUrl = RelayDestinationPolicy.assertDiscordGateway(body.url).toString();
    await this.reconnect();
  }

  send(command: BrokerRelaySendRequest): Promise<void> {
    if (RelayPayloadCodec.jsonBytes(command) > MAX_COMMAND_BYTES) throw new Error('relay_command_too_large');
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('relay_not_connected');
    if (command.type === 'discord.presence') {
      const source = command.payload && typeof command.payload === 'object' ? command.payload as Record<string, unknown> : {};
      const status = ['online', 'dnd', 'idle', 'invisible', 'offline'].includes(String(source.status)) ? source.status : 'online';
      this.socket.send(JSON.stringify({
        op: 3,
        d:  {
          since:      typeof source.since === 'number' ? source.since : null,
          activities: Array.isArray(source.activities) ? RelayPayloadCodec.sanitized(source.activities, this.sensitiveValues) : [],
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
        this.resumeUrl = RelayDestinationPolicy.assertDiscordGateway(frame.d.resume_gateway_url).toString();
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
