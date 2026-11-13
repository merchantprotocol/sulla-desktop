// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { scryptSync } from 'node:crypto';

import { NobleScryptFunction, type ScryptFunction } from '@sulla/domain';

/**
 * Native scrypt for the domain's `ScryptFunction` port. Same cost as `NobleScryptFunction`
 * (N 16384, r 8, p 1) and Node's `scryptSync` defaults that `auth.ts` `makeLoginVerifier` has always used,
 * so stored `login_hash_verifier` / `recovery_verifier` bytes are unchanged; it only runs faster than pure JS.
 */
export class NodeScryptFunction implements ScryptFunction {
  derive(password: Uint8Array, salt: Uint8Array, length: number): Uint8Array {
    const derived = scryptSync(password, salt, length, { N: NobleScryptFunction.N, r: NobleScryptFunction.R, p: NobleScryptFunction.P });
    return new Uint8Array(derived.buffer, derived.byteOffset, derived.byteLength);
  }
}
