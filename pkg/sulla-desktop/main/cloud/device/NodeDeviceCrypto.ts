// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import type { CryptoPrimitives, RandomSource } from '@sulla/domain';

/** The Ed25519 + SHA-256 subset `DeviceIdentityService` needs, on node:crypto (same bytes Desktop always signed with). */
export type DeviceCrypto = Pick<CryptoPrimitives, 'ed25519PublicKey' | 'ed25519Sign' | 'ed25519Verify' | 'sha256'>;

/** node:crypto CSPRNG for device ids and seeds. Throws when unavailable; there is no non-CSPRNG fallback. */
export class NodeRandomSource implements RandomSource {
  constructor(private readonly source: Pick<typeof crypto, 'randomBytes'> = crypto) {}

  bytes(length: number): Uint8Array {
    if (typeof this.source.randomBytes !== 'function') throw new Error('crypto.randomBytes is unavailable');

    return new Uint8Array(this.source.randomBytes(length));
  }
}

/** Seed-based Ed25519 on node:crypto, plus the PKCS#8 PEM <-> seed conversion the key file needs. */
export class NodeDeviceCrypto implements DeviceCrypto {
  /** DER header of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
  private static readonly PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  /** DER header of an SPKI Ed25519 public key; the 32-byte key follows it. */
  private static readonly SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

  static privateKeyFromSeed(seed: Uint8Array): crypto.KeyObject {
    if (seed.length !== 32) throw new Error('An Ed25519 seed is 32 bytes.');

    return crypto.createPrivateKey({ key: Buffer.concat([NodeDeviceCrypto.PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  }

  /** The 32-byte seed inside a PKCS#8 PEM. Throws on anything that is not an Ed25519 private key. */
  static seedFromPem(pem: string): Uint8Array {
    const jwk = crypto.createPrivateKey(pem).export({ format: 'jwk' }) as { crv?: string; d?: string };
    if (jwk.crv !== 'Ed25519' || !jwk.d) throw new Error('not an Ed25519 private key');
    const seed = new Uint8Array(Buffer.from(jwk.d, 'base64url'));
    if (seed.length !== 32) throw new Error('not an Ed25519 private key');

    return seed;
  }

  static pemFromSeed(seed: Uint8Array): string {
    return NodeDeviceCrypto.privateKeyFromSeed(seed).export({ format: 'pem', type: 'pkcs8' }).toString();
  }

  ed25519PublicKey(seed: Uint8Array): Uint8Array {
    const jwk = crypto.createPublicKey(NodeDeviceCrypto.privateKeyFromSeed(seed)).export({ format: 'jwk' }) as { x?: string };
    if (!jwk.x) throw new Error('not an Ed25519 public key');

    return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  }

  ed25519Sign(seed: Uint8Array, message: Uint8Array): Uint8Array {
    return new Uint8Array(crypto.sign(null, Buffer.from(message), NodeDeviceCrypto.privateKeyFromSeed(seed)));
  }

  ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
    if (publicKey.length !== 32) return false;
    try {
      const key = crypto.createPublicKey({ key: Buffer.concat([NodeDeviceCrypto.SPKI_PREFIX, Buffer.from(publicKey)]), format: 'der', type: 'spki' });

      return crypto.verify(null, Buffer.from(message), key, Buffer.from(signature));
    } catch {
      return false;
    }
  }

  sha256(message: Uint8Array): Uint8Array {
    return new Uint8Array(crypto.createHash('sha256').update(message).digest());
  }
}
