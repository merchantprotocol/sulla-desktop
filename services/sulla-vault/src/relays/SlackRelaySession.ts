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

export class SlackRelaySession extends BaseRelaySession {
  /** Slack Socket Mode hosts the bootstrap URL may name. Private so no other module can widen it. */
  private static readonly SOCKET_HOSTS: ReadonlySet<string> = new Set(['wss-primary.slack.com', 'wss-backup.slack.com']);
  private readonly acknowledgements = new Map<number, { envelopeId: string; timer: NodeJS.Timeout }>();

  constructor(relayId: string, credential: string, abortSignal: AbortSignal) {
    super(relayId, 'slack.socket-mode', credential, abortSignal);
  }

  async start(): Promise<void> {
    await this.reconnect();
  }

  send(command: BrokerRelaySendRequest): Promise<void> {
    if (RelayPayloadCodec.jsonBytes(command) > MAX_COMMAND_BYTES) throw new Error('relay_command_too_large');
    if (command.type !== 'slack.ack' || !Number.isSafeInteger(command.sequence)) {
      throw new Error('relay_command_denied');
    }
    const pending = this.acknowledgements.get(command.sequence!);
    if (!pending || this.socket?.readyState !== WebSocket.OPEN) throw new Error('relay_ack_not_pending');
    const responsePayload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
      ? RelayPayloadCodec.sanitized(command.payload, this.sensitiveValues)
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
    const body = await RelayBootstrapReader.readBoundedJson(response).catch(() => null) as { ok?: boolean; url?: string } | null;
    if (!response.ok || !body?.ok || typeof body.url !== 'string') {
      throw new Error('slack_relay_connect_failed');
    }
    const socketUrl = RelayDestinationPolicy.assertProviderWebSocket(body.url, SlackRelaySession.SOCKET_HOSTS);
    this.sensitiveValues.add(socketUrl.toString());
    for (const value of socketUrl.searchParams.values()) this.sensitiveValues.add(value);
    this.connect(socketUrl.toString());
  }
}
