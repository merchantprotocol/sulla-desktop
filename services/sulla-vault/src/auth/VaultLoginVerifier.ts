// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes, scryptSync } from 'node:crypto';

/**
 * Server-side login verifier: scrypt(loginHash, salt, 32) with Node's scryptSync
 * defaults (N 16384, r 8, p 1). Only the writer lives here: production sign-in checks
 * stored verifiers through LocalVaultCrypto#verifyPassword. The old `verify` took its
 * output length from the stored verifier, so an empty or truncated verifier matched
 * any login hash; it had no production caller and was removed.
 */
export class VaultLoginVerifier {
  make(loginHash: string, salt: Buffer = randomBytes(16)): { salt: Buffer; verifier: Buffer } {
    return { salt, verifier: scryptSync(loginHash, salt, 32) };
  }
}
