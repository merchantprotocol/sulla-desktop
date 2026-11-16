// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import NodeWebSocket, { type RawData } from 'ws';

import { SULLA_CLOUD_HOST } from '../sullaCloudRelay.js';
import { BaseRelaySession } from './BaseRelaySession.js';
import {
  BOOTSTRAP_TIMEOUT_MS, MAX_SULLA_CLOUD_BUFFERED_BYTES, MAX_SULLA_CLOUD_EVENT_BYTES, MAX_SULLA_CLOUD_FRAME_BYTES,
} from './RelayLimits.js';

import type { BrokerRelaySendRequest } from '../contracts.js';
import type { SullaCloudSocketFactory } from './RelayContracts.js';

/**
 * Single upstream socket to the Sulla Cloud mobile relay. Text frames pass
 * through verbatim as `sulla-cloud.frame` events (credential redacted); there
 * is no in-vault reconnect: an upstream close ends the stream so Desktop opens
 * a new session, which re-runs the vault-side token refresh.
 */
export class SullaCloudRelaySession extends BaseRelaySession {
  private upstream: NodeWebSocket | null = null;
  private readonly target: URL;

  constructor(
    relayId: string,
    credential: string,
    targetUrl: string,
    abortSignal: AbortSignal,
    private readonly socketFactory: SullaCloudSocketFactory,
  ) {
    super(relayId, 'sulla-cloud.relay', credential, abortSignal, MAX_SULLA_CLOUD_EVENT_BYTES);
    const target = new URL(targetUrl);
    if (target.protocol !== 'wss:' || target.hostname !== SULLA_CLOUD_HOST || target.port ||
        target.username || target.password || target.hash || !target.pathname.startsWith('/relay/')) {
      this.close('relay_destination_denied');
      throw new Error('relay_destination_denied');
    }
    this.target = target;
  }

  async start(): Promise<void> {
    const socket = this.socketFactory(this.target, {
      headers:         { authorization: `Bearer ${ this.credential }` },
      maxPayload:      MAX_SULLA_CLOUD_FRAME_BYTES,
      followRedirects: false,
      handshakeTimeout: BOOTSTRAP_TIMEOUT_MS,
    });
    // ws throws on an unhandled 'error'; failures are reported via open/close.
    socket.on('error', () => undefined);
    this.upstream = socket;
    // Attach before awaiting open: ws can emit frames bundled with the upgrade
    // response synchronously after 'open'.
    let opened = false;
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
      try {
        this.output.push('sulla-cloud.frame', { data: text });
      } catch {
        socket.close(1009, 'invalid_frame');
      }
    });
    socket.on('close', (code: number) => {
      if (this.upstream === socket) this.upstream = null;
      if (!opened || this.closed) return;
      this.output.push('relay.closed', { code });
      this.drainOnClose = true;
      this.close('upstream_closed');
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.terminate(); reject(new Error('relay_connect_timeout')) }, BOOTSTRAP_TIMEOUT_MS);
      timeout.unref?.();
      socket.once('open', () => { opened = true; clearTimeout(timeout); resolve() });
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timeout);
        const status = response.statusCode ?? 0;
        response.resume();
        socket.terminate();
        reject(new Error(status === 401 || status === 403 ? 'relay_unauthorized' : 'relay_connect_failed'));
      });
      socket.once('error', () => { clearTimeout(timeout); reject(new Error('relay_connect_failed')) });
    });
    if (this.closed) {
      socket.terminate();
      throw new Error('relay_closed');
    }
  }

  send(command: BrokerRelaySendRequest): Promise<void> {
    if (command.type !== 'sulla-cloud.frame') throw new Error('relay_command_denied');
    const payload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
      ? command.payload as Record<string, unknown>
      : {};
    const data = payload.data;
    if (typeof data !== 'string' || !data || Buffer.byteLength(data) > MAX_SULLA_CLOUD_FRAME_BYTES) {
      throw new Error('relay_command_invalid');
    }
    const socket = this.upstream;
    if (!socket || socket.readyState !== NodeWebSocket.OPEN) throw new Error('relay_not_connected');
    if (socket.bufferedAmount > MAX_SULLA_CLOUD_BUFFERED_BYTES) throw new Error('relay_backpressure');
    socket.send(data);
    return Promise.resolve();
  }

  override close(reason?: string): void {
    const socket = this.upstream;
    this.upstream = null;
    if (socket && socket.readyState !== NodeWebSocket.CLOSED) {
      try { socket.close(1000, 'relay_closed') } catch { socket.terminate() }
    }
    super.close(reason);
  }

  protected onOpen(_socket: WebSocket): void {}
  protected onMessage(_socket: WebSocket, _data: unknown): void {}
  protected async reconnect(): Promise<void> {}
}
