// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import { RuntimeClockSyncAuthenticator } from '../../../packages/runtime-protocol/src/runtimeClockSync.js';

export class HostClockSyncClient {
  private readonly authenticator: RuntimeClockSyncAuthenticator;

  constructor(
    private readonly endpoint: string,
    private readonly installationSecret: string,
    private readonly request: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly createNonce: () => string = () => crypto.randomBytes(16).toString('base64url'),
  ) {
    this.authenticator = new RuntimeClockSyncAuthenticator(installationSecret);
  }

  async synchronize(): Promise<void> {
    const target = new URL(this.endpoint);
    const port = Number(target.port);
    if (target.protocol !== 'http:' || target.hostname !== 'host.sulla.internal' ||
        !Number.isInteger(port) || port < 1 || port > 65_535 || target.pathname !== '/internal/runtime/sync-clock' ||
        target.username || target.password || target.search || target.hash) {
      throw new Error('Runtime clock sync endpoint is not the trusted Desktop host');
    }

    const nonce = this.createNonce();
    const response = await this.request(target, {
      method:   'POST',
      headers:  {
        authorization:                    `Bearer ${ this.installationSecret }`,
        'content-type':                   'application/json',
        'x-sulla-clock-sync-nonce':       nonce,
        'x-sulla-clock-sync-signature':   this.authenticator.sign(nonce),
      },
      body:     '{}',
      redirect: 'error',
      signal:   AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error('Desktop host refused runtime clock synchronization');
  }
}
