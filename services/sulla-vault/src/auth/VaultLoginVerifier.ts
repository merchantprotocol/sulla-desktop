// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Server-side login verifier: scrypt(loginHash, salt, 32) with Node's scryptSync
 * defaults (N 16384, r 8, p 1), compared in constant time.
 */
export class VaultLoginVerifier {
  make(loginHash: string, salt: Buffer = randomBytes(16)): { salt: Buffer; verifier: Buffer } {
    return { salt, verifier: scryptSync(loginHash, salt, 32) };
  }

  verify(loginHash: string, salt: Uint8Array, expected: Uint8Array): boolean {
    const actual = scryptSync(loginHash, salt, expected.byteLength);
    return timingSafeEqual(actual, expected);
  }
}
