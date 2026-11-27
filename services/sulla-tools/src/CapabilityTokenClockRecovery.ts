// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  CapabilityTokenError, verifyCapabilityToken,
} from '../../../packages/runtime-protocol/src/capabilityToken.js';

import type {
  CapabilityRevocationStore, CapabilityTokenClaims,
} from '../../../packages/runtime-protocol/src/capabilityToken.js';

export interface CapabilityTokenVerificationOptions {
  category?:             string;
  tool?:                 string;
  revocations?:          CapabilityRevocationStore;
  clockToleranceSeconds?: number;
}

/** Re-syncs the trusted VM clock once for an authenticated token time error. */
export class CapabilityTokenClockRecovery {
  constructor(
    private readonly synchronizeClock: () => Promise<void>,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async verify(
    token: string | undefined,
    signingKey: string | Buffer,
    options: CapabilityTokenVerificationOptions = {},
  ): Promise<CapabilityTokenClaims> {
    try {
      return await this.verifyAtCurrentTime(token, signingKey, options);
    } catch (error) {
      if (!(error instanceof CapabilityTokenError) || !['not_yet_valid', 'expired'].includes(error.code)) throw error;
      // HMAC verification precedes time checks. Sync only for a signed token,
      // once, then run the full verifier again; failed sync never widens tolerance.
      try { await this.synchronizeClock() } catch { throw error }
      return this.verifyAtCurrentTime(token, signingKey, options);
    }
  }

  private verifyAtCurrentTime(
    token: string | undefined,
    signingKey: string | Buffer,
    options: CapabilityTokenVerificationOptions,
  ): Promise<CapabilityTokenClaims> {
    return verifyCapabilityToken(token, signingKey, { ...options, now: this.nowSeconds() });
  }
}
