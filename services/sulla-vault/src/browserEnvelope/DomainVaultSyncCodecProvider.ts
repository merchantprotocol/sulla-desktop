// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { loadSodium } from './envelope.js';
import { DomainVaultSyncCodec } from './DomainVaultSyncCodec.js';
import { SodiumCryptoPrimitives } from './SodiumCryptoPrimitives.js';

/** Lazily constructs and shares one codec for the vault-service composition. */
export class DomainVaultSyncCodecProvider {
  private codec: Promise<DomainVaultSyncCodec> | null = null;
  get(): Promise<DomainVaultSyncCodec> {
    this.codec ??= loadSodium().then(sodium => {
      const crypto = new SodiumCryptoPrimitives(sodium);
      return new DomainVaultSyncCodec(crypto, crypto);
    });
    return this.codec;
  }
}
