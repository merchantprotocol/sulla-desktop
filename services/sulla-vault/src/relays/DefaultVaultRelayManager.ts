// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import NodeWebSocket from 'ws';

import { BaseRelaySession } from './BaseRelaySession.js';
import { DiscordRelaySession } from './DiscordRelaySession.js';
import { EnterpriseGatewayRelaySession } from './EnterpriseGatewayRelaySession.js';
import { SullaCloudRelaySession } from './SullaCloudRelaySession.js';

import type { BrokerRelaySendRequest } from '../contracts.js';
import type {
  RelaySession, SullaCloudSocketFactory, VaultRelayEvent, VaultRelayHandle, VaultRelayManager, VaultRelayOpenRequest,
} from './RelayContracts.js';

export class DefaultVaultRelayManager implements VaultRelayManager {
  private readonly sessions = new Map<string, RelaySession>();

  constructor(
    private readonly sullaCloudSocket: SullaCloudSocketFactory = (url, options) => new NodeWebSocket(url, options),
  ) {}

  async open(request: VaultRelayOpenRequest): Promise<VaultRelayHandle> {
    if (!request.relayId || !request.credential || request.abortSignal.aborted) throw new Error('invalid_relay_request');
    if (this.sessions.has(request.relayId)) throw new Error('relay_already_exists');
    const session: RelaySession = request.operation === 'discord.gateway'
      ? new DiscordRelaySession(request.relayId, request.credential, request.abortSignal)
      : request.operation === 'sulla-cloud.relay'
        ? new SullaCloudRelaySession(
          request.relayId, request.credential, request.targetUrl ?? '', request.abortSignal, this.sullaCloudSocket,
        )
        : new EnterpriseGatewayRelaySession(
          request.relayId,
          request.credential,
          request.gatewayUrl ?? '',
          request.gatewayAddress,
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
