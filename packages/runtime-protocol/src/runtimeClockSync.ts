// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

const CLOCK_SYNC_DOMAIN = 'sulla-runtime-clock-sync-v1';

/** Signs a one-use request for the host to set the guest VM clock. */
export class RuntimeClockSyncAuthenticator {
  constructor(private readonly installationSecret: string | Buffer) {
    if (!installationSecret || Buffer.byteLength(installationSecret) < 32) {
      throw new Error('Runtime clock sync secret must be at least 32 bytes');
    }
  }

  sign(nonce: string): string {
    if (!RuntimeClockSyncAuthenticator.isValidNonce(nonce)) throw new Error('Invalid runtime clock sync nonce');

    return crypto.createHmac('sha256', this.installationSecret)
      .update(`${ CLOCK_SYNC_DOMAIN }\n${ nonce }`)
      .digest('base64url');
  }

  verify(nonce: string, signature: string): boolean {
    if (!RuntimeClockSyncAuthenticator.isValidNonce(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    const expected = Buffer.from(this.sign(nonce), 'base64url');
    const presented = Buffer.from(signature, 'base64url');
    return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
  }

  static isValidNonce(nonce: string): boolean {
    return /^[A-Za-z0-9_-]{22}$/.test(nonce);
  }
}
