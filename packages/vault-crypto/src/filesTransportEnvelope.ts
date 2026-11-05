// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const transportSalt = encoder.encode('sulla-files-sync-transport-v1');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Bytes = Uint8Array<ArrayBuffer>;
const view = (value: Uint8Array): Bytes => value as Bytes;

export interface FilesTransportEnvelope {
  format: 'sulla-files-sync-transport';
  v: 1;
  alg: 'ECDH-P256+HKDF-SHA256+A256GCM';
  epk: string;
  nonce: string;
  ct: string;
}

export class FilesTransportEnvelopeService {
  private b64u(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64url') }

  private unb64u(value: string): Bytes {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('bad base64url');
    return new Uint8Array(Buffer.from(value, 'base64url'));
  }

  private async deriveKey(privateKey: CryptoKey, peerPublicKey: string, info: string, use: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
    const peer = await subtle.importKey('raw', this.unb64u(peerPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
    try {
      const base = await subtle.importKey('raw', view(shared), 'HKDF', false, ['deriveBits']);
      const raw = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: view(transportSalt), info: encoder.encode(info) }, base, 256));
      return subtle.importKey('raw', view(raw), { name: 'AES-GCM' }, false, [use]);
    } finally { shared.fill(0) }
  }

  private info(requestId: string, vaultId: string, vaultEpoch: number): string {
    if (!uuid.test(requestId)) throw new Error('bad requestId');
    return `${ requestId }|${ vaultId }|${ vaultEpoch }`;
  }

  async wrap(plaintext: Uint8Array, recipientPublicKey: string, requestId: string, vaultId: string, vaultEpoch: number): Promise<FilesTransportEnvelope> {
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength < 1 || plaintext.byteLength > 2_000_000) throw new Error('bad transport payload');
    const info = this.info(requestId, vaultId, vaultEpoch);
    const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
    const epk = this.b64u(new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey)));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`sulla-fs1|transport|${ info }|${ epk }`), tagLength: 128 },
      await this.deriveKey(ephemeral.privateKey, recipientPublicKey, info, 'encrypt'), view(plaintext),
    ));
    return { format: 'sulla-files-sync-transport', v: 1, alg: 'ECDH-P256+HKDF-SHA256+A256GCM', epk, nonce: this.b64u(iv), ct: this.b64u(ct) };
  }

  async unwrap(envelope: FilesTransportEnvelope, recipientPrivateKey: CryptoKey, requestId: string, vaultId: string, vaultEpoch: number): Promise<Uint8Array> {
    if (envelope?.format !== 'sulla-files-sync-transport' || envelope.v !== 1 || envelope.alg !== 'ECDH-P256+HKDF-SHA256+A256GCM') throw new Error('unsupported transport');
    const info = this.info(requestId, vaultId, vaultEpoch);
    const out = new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: this.unb64u(envelope.nonce), additionalData: encoder.encode(`sulla-fs1|transport|${ info }|${ envelope.epk }`), tagLength: 128 },
      await this.deriveKey(recipientPrivateKey, envelope.epk, info, 'decrypt'), this.unb64u(envelope.ct),
    ));
    if (out.byteLength < 1 || out.byteLength > 2_000_000) throw new Error('bad transport');
    return out;
  }
}
