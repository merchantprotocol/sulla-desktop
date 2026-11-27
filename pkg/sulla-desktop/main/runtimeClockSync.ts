// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { RuntimeClockSyncAuthenticator } from '../../../packages/runtime-protocol/src/runtimeClockSync.js';

export interface RuntimeClockSyncRequest {
  remoteAddress: string;
  nonce:         string;
  signature:     string;
}

export interface RuntimeClockSyncResponse {
  status: 200 | 403 | 409 | 503;
  error?: 'forbidden' | 'replayed' | 'unavailable';
}

/** Authorizes a guest service to request host-authoritative VM clock correction. */
export class HostRuntimeClockSyncEndpoint {
  private readonly consumedNonces = new Set<string>();
  private readonly nonceOrder: string[] = [];

  constructor(
    private readonly installationSecret: () => string,
    private readonly synchronizeGuestClock: () => Promise<void>,
  ) {}

  async handle(request: RuntimeClockSyncRequest): Promise<RuntimeClockSyncResponse> {
    const secret = this.installationSecret();
    if (!HostRuntimeClockSyncEndpoint.isPrivateSource(request.remoteAddress) || Buffer.byteLength(secret) < 32 ||
        !new RuntimeClockSyncAuthenticator(secret).verify(request.nonce, request.signature)) {
      return { status: 403, error: 'forbidden' };
    }

    if (this.consumedNonces.has(request.nonce)) return { status: 409, error: 'replayed' };
    this.rememberNonce(request.nonce);

    try {
      // The host computes time itself; no client-supplied timestamp is trusted.
      await this.synchronizeGuestClock();
      return { status: 200 };
    } catch {
      return { status: 503, error: 'unavailable' };
    }
  }

  private rememberNonce(nonce: string): void {
    const maxRemembered = 2048;
    if (this.nonceOrder.length >= maxRemembered) {
      const oldest = this.nonceOrder.shift();
      if (oldest) this.consumedNonces.delete(oldest);
    }
    this.nonceOrder.push(nonce);
    this.consumedNonces.add(nonce);
  }

  private static isPrivateSource(address: string): boolean {
    const normalized = address.replace(/^::ffff:/, '');
    return /^(::1|127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(normalized);
  }
}
