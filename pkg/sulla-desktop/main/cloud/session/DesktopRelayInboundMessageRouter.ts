// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { RelaySocketLike } from '@pkg/main/cloudRelayTransport';

export interface RelayIncomingMessage {
  type: string;
  requestId?: string;
  linkId?: string;
  targetDeviceId?: string;
  conversationId?: string;
  reason?: string;
  code?: string;
  expiresAt?: string;
  requestingDeviceId?: string;
  requestingDeviceName?: string;
  [key: string]: unknown;
}

export interface RelayMessageRouteDependencies {
  deviceId(): Promise<string>;
  surfaceSignInCode(payload: { requestId: string; code: string; expiresAt: string; requestingDeviceId: string; requestingDeviceName: string }): void;
  connected(): void;
  error(reason: string | undefined): void;
  companion(message: RelayIncomingMessage): Promise<void>;
  shareFetch(message: RelayIncomingMessage, socket: RelaySocketLike, generation: number): Promise<void>;
  shareFetchCancel(message: RelayIncomingMessage, socket: RelaySocketLike | undefined, generation: number): void;
  chat(message: RelayIncomingMessage): Promise<void>;
  cancel(message: RelayIncomingMessage): void;
  inject(message: RelayIncomingMessage): Promise<void>;
  clearSecureRoute(conversationId: string): void;
  log: {
    info(message: string): void;
    warn(message: string, error?: unknown): void;
    error(message: string): void;
    log(message: string): void;
  };
}

/** Routes validated inbound relay frames to the desktop's session handlers. */
export class DesktopRelayInboundMessageRouter {
  constructor(private readonly dependencies: RelayMessageRouteDependencies) {}

  async route(raw: string, sourceSocket?: RelaySocketLike, sourceGeneration = 0): Promise<void> {
    let message: RelayIncomingMessage;
    try {
      message = JSON.parse(raw) as RelayIncomingMessage;
    } catch {
      this.dependencies.log.warn('[DesktopRelay] Non-JSON message received');
      return;
    }

    if (message.type === 'other_device_signin_code') {
      if (!message.requestId || !/^\d{6}$/.test(String(message.code ?? '')) || !message.expiresAt || !message.requestingDeviceId) return;
      if (message.requestingDeviceId === await this.dependencies.deviceId()) return;
      this.dependencies.surfaceSignInCode({
        requestId: message.requestId, code: String(message.code), expiresAt: message.expiresAt,
        requestingDeviceId: message.requestingDeviceId, requestingDeviceName: message.requestingDeviceName ?? 'another device',
      });
      this.dependencies.log.info(`[DesktopRelay] Received other-device sign-in approval ${ message.requestId }`);
      return;
    }

    if (message.type === 'connected') { this.dependencies.connected(); return; }
    if (message.type === 'pong') return;
    if (message.type === 'error') { this.dependencies.error(message.reason); return; }

    if (message.type === 'companion_request') {
      if (!message.requestId || !message.targetDeviceId || message.targetDeviceId !== await this.dependencies.deviceId()) return;
      await this.dependencies.companion(message);
      return;
    }
    if (message.type === 'share_fetch') {
      if (!message.requestId || !message.linkId || !message.targetDeviceId || message.targetDeviceId !== await this.dependencies.deviceId() || !sourceSocket) return;
      await this.dependencies.shareFetch(message, sourceSocket, sourceGeneration);
      return;
    }
    if (message.type === 'share_fetch_cancel') {
      if (!message.requestId || !message.targetDeviceId || message.targetDeviceId !== await this.dependencies.deviceId()) return;
      this.dependencies.shareFetchCancel(message, sourceSocket, sourceGeneration);
      return;
    }
    if (message.type === 'chat') {
      if (message.conversationId) this.dependencies.clearSecureRoute(message.conversationId);
      if (message.targetDeviceId) {
        try {
          const myId = await this.dependencies.deviceId();
          if (message.targetDeviceId !== myId) {
            this.dependencies.log.log(`[DesktopRelay] Ignoring chat — addressed to ${ message.targetDeviceId }, I am ${ myId }`);
            return;
          }
        } catch (error) {
          this.dependencies.log.warn('[DesktopRelay] device_id lookup failed; refusing targeted chat:', error);
          return;
        }
      }
      await this.dependencies.chat(message);
      return;
    }
    if (message.type === 'cancel') {
      if (message.conversationId) this.dependencies.clearSecureRoute(message.conversationId);
      this.dependencies.cancel(message);
      return;
    }
    if (message.type === 'inject') {
      if (message.conversationId) this.dependencies.clearSecureRoute(message.conversationId);
      await this.dependencies.inject(message);
      return;
    }
    this.dependencies.log.log(`[DesktopRelay] Unknown message type: ${ message.type }`);
  }
}
