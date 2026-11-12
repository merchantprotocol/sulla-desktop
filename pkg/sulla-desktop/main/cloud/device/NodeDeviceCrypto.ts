// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import type { Ed25519Primitives, RandomSource } from './DeviceIdentityPorts';

/** node:crypto CSPRNG. Throws if it is missing; never falls back to Math.random. */
export class NodeCryptoRandomSource implements RandomSource {
  constructor(private readonly source: Pick<typeof crypto, 'randomFillSync'> = crypto) {}

  bytes(length: number): Uint8Array {
    if (typeof this.source.randomFillSync !== 'function') throw new Error('crypto.randomFillSync is unavailable');

    return this.source.randomFillSync(new Uint8Array(length));
  }
}

/** Seed-based Ed25519 on node:crypto, with the same method names as the domain CryptoPrimitives. */
export class NodeEd25519Primitives implements Ed25519Primitives {
  /** DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
  private static readonly PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

  static privateKeyFromSeed(seed: Uint8Array): crypto.KeyObject {
    if (seed.length !== 32) throw new Error('An Ed25519 seed is 32 bytes.');

    return crypto.createPrivateKey({ key: Buffer.concat([NodeEd25519Primitives.PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  }

  static seedFromPrivateKey(key: crypto.KeyObject): Uint8Array {
    const jwk = key.export({ format: 'jwk' }) as { crv?: string; d?: string };
    if (jwk.crv !== 'Ed25519' || !jwk.d) throw new Error('not an Ed25519 private key');

    return new Uint8Array(Buffer.from(jwk.d, 'base64url'));
  }

  ed25519PublicKey(seed: Uint8Array): Uint8Array {
    const jwk = crypto.createPublicKey(NodeEd25519Primitives.privateKeyFromSeed(seed)).export({ format: 'jwk' }) as { x?: string };
    if (!jwk.x) throw new Error('not an Ed25519 public key');

    return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  }

  ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array {
    return new Uint8Array(crypto.sign(null, Buffer.from(message), NodeEd25519Primitives.privateKeyFromSeed(seed)));
  }
}
