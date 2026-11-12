// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { NobleCryptoPrimitives } from '@sulla/domain';

import { loadSodium } from '../browserEnvelope/envelope.js';
import { SodiumCryptoPrimitives } from '../browserEnvelope/SodiumCryptoPrimitives.js';
import { LocalVaultCrypto } from './LocalVaultCrypto.js';

/** Lazily builds the vault service's `LocalVaultCrypto` on libsodium (Argon2id, XChaCha20, CSPRNG). */
export class LocalVaultCryptoProvider {
  private crypto: Promise<LocalVaultCrypto> | null = null;

  /** Pass a ready instance (tests) or let the provider compose one on the libsodium primitives. */
  constructor(crypto?: LocalVaultCrypto) {
    if (crypto) this.crypto = Promise.resolve(crypto);
  }

  get(): Promise<LocalVaultCrypto> {
    this.crypto ??= loadSodium().then(sodium => {
      const primitives = new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives());
      return LocalVaultCrypto.compose(primitives, primitives);
    });
    return this.crypto;
  }
}
