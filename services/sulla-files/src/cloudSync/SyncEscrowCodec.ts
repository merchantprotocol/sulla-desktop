// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { EscrowEnvelope, TransportEnvelope } from './envelopeTypes.js';
import { SyncCryptoPrimitives, type Bytes } from './SyncCryptoPrimitives.js';

/**
 * Key custody for Files sync envelope v1: the collection root escrowed under the Vault
 * account key, and container-to-container key transport (Vault → Files) with an
 * ephemeral P-256 ECDH + HKDF-SHA256 + AES-256-GCM. The recipient generates a fresh
 * P-256 key pair per request and discards it after unwrapping.
 */
export class SyncEscrowCodec {
  private readonly escrowSalt:Bytes;
  private readonly transportSalt:Bytes;

  constructor(private readonly crypto = new SyncCryptoPrimitives()) {
    this.escrowSalt = crypto.enc.encode('sulla-files-sync-escrow-v1');
    this.transportSalt = crypto.enc.encode('sulla-files-sync-transport-v1');
  }

  /** Escrow key itself: never persisted outside memory. */
  escrowKey(userKey:Uint8Array, vaultId:string, vaultEpoch:number):Promise<Uint8Array> {
    return this.crypto.hkdf(userKey, this.escrowSalt, `${ vaultId }|${ vaultEpoch }`);
  }

  /** userKey = the Vault account key (32 B). Runs only where userKey already lives (tests and KAT only here). */
  async sealEscrow(
    userKey:Uint8Array,
    vaultId:string,
    vaultEpoch:number,
    collectionId:string,
    keyVersion:number,
    root:Uint8Array,
    fixedNonce?:Uint8Array,
  ):Promise<EscrowEnvelope> {
    return this.sealEscrowWithKey(await this.escrowKey(userKey, vaultId, vaultEpoch), vaultId, vaultEpoch, collectionId, keyVersion, root, fixedNonce);
  }

  async openEscrow(userKey:Uint8Array, envelope:EscrowEnvelope):Promise<Uint8Array> {
    this.assertEscrowEnvelope(envelope);
    return this.openEscrowWithKey(await this.escrowKey(userKey, envelope.vaultId, envelope.vaultEpoch), envelope);
  }

  /** Same as sealEscrow/openEscrow but starting from an already-derived escrow key (Files service side). */
  async sealEscrowWithKey(
    ek:Uint8Array,
    vaultId:string,
    vaultEpoch:number,
    collectionId:string,
    keyVersion:number,
    root:Uint8Array,
    fixedNonce?:Uint8Array,
  ):Promise<EscrowEnvelope> {
    const c = this.crypto;
    c.assertUuid(vaultId, 'vaultId');
    c.assertUuid(collectionId, 'collectionId');
    c.assertKeyVersion(keyVersion);
    if (!(root instanceof Uint8Array) || root.byteLength !== 32) throw new Error('bad root');
    const iv = c.nonce12(fixedNonce);
    const ct = new Uint8Array(await c.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.escrowAad(collectionId, keyVersion, vaultId, vaultEpoch), tagLength: 128 },
      await c.aesKey(ek, 'encrypt'),
      c.view(root),
    ));
    return {
      format: 'sulla-files-sync-escrow', v: 1, alg: 'A256GCM', kdf: 'HKDF-SHA256',
      vaultId, vaultEpoch, collectionId, keyVersion, nonce: c.b64u(iv), ct: c.b64u(ct),
    };
  }

  async openEscrowWithKey(ek:Uint8Array, envelope:EscrowEnvelope):Promise<Uint8Array> {
    const c = this.crypto;
    this.assertEscrowEnvelope(envelope);
    const root = new Uint8Array(await c.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: c.unb64u(envelope.nonce),
        additionalData: this.escrowAad(envelope.collectionId, envelope.keyVersion, envelope.vaultId, envelope.vaultEpoch),
        tagLength: 128,
      },
      await c.aesKey(ek, 'decrypt'),
      c.unb64u(envelope.ct),
    ));
    if (root.byteLength !== 32) throw new Error('bad escrow');
    return root;
  }

  async generateTransportKeyPair():Promise<{ privateKey:CryptoKey; publicKey:string }> {
    const c = this.crypto;
    const pair = await c.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
    return { privateKey: pair.privateKey, publicKey: c.b64u(new Uint8Array(await c.subtle.exportKey('raw', pair.publicKey))) };
  }

  async transportWrapBytes(
    plaintext:Uint8Array,
    recipientPublicKey:string,
    requestId:string,
    vaultId:string,
    vaultEpoch:number,
  ):Promise<TransportEnvelope> {
    const c = this.crypto;
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength < 1 || plaintext.byteLength > 2_000_000) throw new Error('bad transport payload');
    c.assertUuid(requestId, 'requestId');
    const ephemeral = await c.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
    const epk = c.b64u(new Uint8Array(await c.subtle.exportKey('raw', ephemeral.publicKey)));
    const info = this.transportInfo(requestId, vaultId, vaultEpoch);
    const iv = c.nonce12();
    const ct = new Uint8Array(await c.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: c.enc.encode(`sulla-fs1|transport|${ info }|${ epk }`), tagLength: 128 },
      await this.transportKey(ephemeral.privateKey, recipientPublicKey, info, 'encrypt'),
      c.view(plaintext),
    ));
    return { format: 'sulla-files-sync-transport', v: 1, alg: 'ECDH-P256+HKDF-SHA256+A256GCM', epk, nonce: c.b64u(iv), ct: c.b64u(ct) };
  }

  async transportUnwrapBytes(
    envelope:TransportEnvelope,
    recipientPrivateKey:CryptoKey,
    requestId:string,
    vaultId:string,
    vaultEpoch:number,
  ):Promise<Uint8Array> {
    const c = this.crypto;
    if (envelope?.format !== 'sulla-files-sync-transport' || envelope.v !== 1 || envelope.alg !== 'ECDH-P256+HKDF-SHA256+A256GCM') throw new Error('unsupported transport');
    const info = this.transportInfo(requestId, vaultId, vaultEpoch);
    const out = new Uint8Array(await c.subtle.decrypt(
      { name: 'AES-GCM', iv: c.unb64u(envelope.nonce), additionalData: c.enc.encode(`sulla-fs1|transport|${ info }|${ envelope.epk }`), tagLength: 128 },
      await this.transportKey(recipientPrivateKey, envelope.epk, info, 'decrypt'),
      c.unb64u(envelope.ct),
    ));
    if (out.byteLength < 1 || out.byteLength > 2_000_000) throw new Error('bad transport');
    return out;
  }

  async transportWrap(key32:Uint8Array, recipientPublicKey:string, requestId:string, vaultId:string, vaultEpoch:number):Promise<TransportEnvelope> {
    if (key32.byteLength !== 32) throw new Error('bad transport key');
    return this.transportWrapBytes(key32, recipientPublicKey, requestId, vaultId, vaultEpoch);
  }

  async transportUnwrap(envelope:TransportEnvelope, recipientPrivateKey:CryptoKey, requestId:string, vaultId:string, vaultEpoch:number):Promise<Uint8Array> {
    const out = await this.transportUnwrapBytes(envelope, recipientPrivateKey, requestId, vaultId, vaultEpoch);
    if (out.byteLength !== 32) throw new Error('bad transport');
    return out;
  }

  private escrowAad(collectionId:string, keyVersion:number, vaultId:string, vaultEpoch:number):Bytes {
    return this.crypto.enc.encode(`sulla-fs1|escrow|${ collectionId }|${ keyVersion }|${ vaultId }|${ vaultEpoch }`);
  }

  private assertEscrowEnvelope(envelope:EscrowEnvelope):void {
    if (envelope?.format !== 'sulla-files-sync-escrow' || envelope.v !== 1 || envelope.alg !== 'A256GCM' || envelope.kdf !== 'HKDF-SHA256') {
      throw new Error('unsupported escrow');
    }
  }

  private transportInfo(requestId:string, vaultId:string, vaultEpoch:number):string {
    return `${ requestId }|${ vaultId }|${ vaultEpoch }`;
  }

  private async transportKey(privateKey:CryptoKey, peerPublicKey:string, info:string, use:'encrypt' | 'decrypt'):Promise<CryptoKey> {
    const c = this.crypto;
    const peer = await c.subtle.importKey('raw', c.unb64u(peerPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await c.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
    try {
      return await c.aesKey(await c.hkdf(shared, this.transportSalt, info), use);
    } finally {
      shared.fill(0);
    }
  }
}
