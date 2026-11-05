// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createRequire } from 'node:module';

import {
  CallbackRandomSource,
  CanonicalJson,
  KeyWrap,
  NobleCryptoPrimitives,
  VaultSyncCodec,
  type CryptoPrimitives,
  type RandomSource,
} from '@sulla/domain';

import { SodiumMasterKeyDeriver, type Sodium } from './SodiumMasterKeyDeriver.js';
import { VaultSyncEnvelope } from './VaultSyncEnvelope.js';
import { VaultSyncExportMapper } from './VaultSyncExportMapper.js';
import { VaultSyncSealer } from './VaultSyncSealer.js';
import { VaultSyncShape } from './VaultSyncShape.js';

/**
 * The vault container's single composition point for the shared sync domain.
 * libsodium stays on the runtime side of the boundary: it supplies randomness
 * and Argon2id; everything else is @sulla/domain.
 */
export class VaultSyncRuntime {
  readonly crypto: CryptoPrimitives;
  readonly random: RandomSource;
  readonly canonical: CanonicalJson;
  readonly codec: VaultSyncCodec;
  readonly envelope: VaultSyncEnvelope;
  readonly exports: VaultSyncExportMapper;

  constructor(sodium: Sodium) {
    const shape = new VaultSyncShape();
    const masterKeys = new SodiumMasterKeyDeriver(sodium, shape);
    this.crypto = new NobleCryptoPrimitives();
    this.random = new CallbackRandomSource((length) => sodium.randombytes_buf(length));
    this.canonical = new CanonicalJson();
    const wraps = new KeyWrap(this.crypto, this.random);
    this.codec = new VaultSyncCodec(this.crypto, wraps, masterKeys);
    const sealer = new VaultSyncSealer(this.crypto, this.codec, this.canonical, shape);
    this.envelope = new VaultSyncEnvelope(this.codec, wraps, masterKeys, sealer, shape);
    this.exports = new VaultSyncExportMapper();
  }

  static async create(): Promise<VaultSyncRuntime> {
    return new VaultSyncRuntime(await VaultSyncRuntime.loadSodium());
  }

  /**
   * libsodium-wrappers-sumo, resolved next to @sulla/vault-crypto (its pinned
   * owner), so the vault service needs no second copy or version.
   */
  private static async loadSodium(): Promise<Sodium> {
    let sodium: Sodium;
    try {
      sodium = createRequire(import.meta.resolve('@sulla/vault-crypto'))('libsodium-wrappers-sumo');
    } catch {
      // Test runners that inline @sulla/vault-crypto resolve libsodium directly.
      sodium = (await import('libsodium-wrappers-sumo' as string)).default;
    }
    await sodium.ready;
    return sodium;
  }
}
