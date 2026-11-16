// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  CollectionInfoEnvelope, CollectionInfoPlain, ManifestEnvelope, ManifestPlain, NamespaceManifestPlain, StateEntry, SyncHead,
} from './envelopeTypes.js';
import { SyncCryptoPrimitives, type Bytes } from './SyncCryptoPrimitives.js';

/**
 * Seals and opens what a collection stores in Cloud under its sync root: chunks,
 * manifests, the collection's folder name, the stateHash and the signed head.
 * 1:1 port of FILES-SYNC-ENVELOPE-v1; the bytes are the wire format.
 */
export class SyncEnvelopeCodec {
  static readonly flagDeflateRaw = 0x01;
  static readonly chunkPlainBytes = 4 * 1024 * 1024;
  private static readonly magic = [0x53, 0x46, 0x43, 0x31]; // "SFC1"
  private static readonly headerBytes = 4 + 1 + 4 + 12;

  constructor(private readonly crypto = new SyncCryptoPrimitives()) {}

  /** Chunk id = hex HMAC-SHA256(subkey(chunk-id), plaintext). Dedupe scope = one collection. */
  async chunkId(root:Uint8Array, collectionId:string, keyVersion:number, plain:Uint8Array):Promise<string> {
    const c = this.crypto;
    const key = await c.hmacKey(await c.subkey(root, 'chunk-id', collectionId, keyVersion));
    return c.hex(await c.subtle.sign('HMAC', key, c.view(plain)));
  }

  /** body = already-compressed bytes when flags has FLAG_DEFLATE_RAW. Returns wire bytes. */
  async sealChunk(
    root:Uint8Array,
    collectionId:string,
    keyVersion:number,
    id:string,
    body:Uint8Array,
    flags = 0,
    fixedNonce?:Uint8Array,
  ):Promise<Uint8Array> {
    const c = this.crypto;
    if (!SyncCryptoPrimitives.hex64.test(id)) throw new Error('bad chunkId');
    if (flags & ~SyncEnvelopeCodec.flagDeflateRaw) throw new Error('bad flags');
    const iv = c.nonce12(fixedNonce);
    const key = await c.aesKey(await c.subkey(root, 'chunk', collectionId, keyVersion, id), 'encrypt');
    const ct = new Uint8Array(await c.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.chunkAad(collectionId, keyVersion, id, flags), tagLength: 128 },
      key,
      c.view(body),
    ));
    const header = SyncEnvelopeCodec.headerBytes;
    const out = new Uint8Array(header + ct.byteLength);
    out.set(SyncEnvelopeCodec.magic, 0);
    out[4] = flags;
    new DataView(out.buffer).setUint32(5, keyVersion);
    out.set(iv, 9);
    out.set(ct, header);
    return out;
  }

  /** Returns { flags, body }. Caller inflates when FLAG_DEFLATE_RAW, then MUST verify chunkId(plain) === id. */
  async openChunk(
    root:Uint8Array,
    collectionId:string,
    keyVersion:number,
    id:string,
    wire:Uint8Array,
  ):Promise<{ flags:number; body:Uint8Array }> {
    const c = this.crypto;
    const header = SyncEnvelopeCodec.headerBytes;
    if (!SyncCryptoPrimitives.hex64.test(id)) throw new Error('bad chunkId');
    if (wire.byteLength < header + 16 || SyncEnvelopeCodec.magic.some((magic, index) => wire[index] !== magic)) throw new Error('bad chunk header');
    const flags = wire[4];
    if (flags & ~SyncEnvelopeCodec.flagDeflateRaw) throw new Error('bad flags');
    if (new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint32(5) !== keyVersion) throw new Error('keyVersion mismatch');
    const key = await c.aesKey(await c.subkey(root, 'chunk', collectionId, keyVersion, id), 'decrypt');
    const body = new Uint8Array(await c.subtle.decrypt(
      { name: 'AES-GCM', iv: c.view(wire.subarray(9, 21)), additionalData: this.chunkAad(collectionId, keyVersion, id, flags), tagLength: 128 },
      key,
      c.view(wire.subarray(header)),
    ));
    return { flags, body };
  }

  /** Plaintext manifest object → envelope (JSON-safe). */
  async sealManifest(
    root:Uint8Array,
    collectionId:string,
    keyVersion:number,
    fileId:string,
    versionId:string,
    manifest:ManifestPlain | NamespaceManifestPlain,
    fixedNonce?:Uint8Array,
  ):Promise<ManifestEnvelope> {
    const c = this.crypto;
    c.assertUuid(fileId, 'fileId');
    c.assertUuid(versionId, 'versionId');
    const iv = c.nonce12(fixedNonce);
    const key = await c.aesKey(await c.subkey(root, 'manifest', collectionId, keyVersion, versionId), 'encrypt');
    const ct = new Uint8Array(await c.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.manifestAad(collectionId, keyVersion, fileId, versionId), tagLength: 128 },
      key,
      c.enc.encode(JSON.stringify(manifest)),
    ));
    return { format: 'sulla-files-sync-manifest', v: 1, alg: 'A256GCM', collectionId, keyVersion, fileId, versionId, nonce: c.b64u(iv), ct: c.b64u(ct) };
  }

  async openManifest(root:Uint8Array, envelope:ManifestEnvelope):Promise<unknown> {
    const c = this.crypto;
    if (envelope?.format !== 'sulla-files-sync-manifest' || envelope.v !== 1 || envelope.alg !== 'A256GCM') throw new Error('unsupported manifest');
    c.assertUuid(envelope.fileId, 'fileId');
    c.assertUuid(envelope.versionId, 'versionId');
    const key = await c.aesKey(await c.subkey(root, 'manifest', envelope.collectionId, envelope.keyVersion, envelope.versionId), 'decrypt');
    const plain = await c.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: c.unb64u(envelope.nonce),
        additionalData: this.manifestAad(envelope.collectionId, envelope.keyVersion, envelope.fileId, envelope.versionId),
        tagLength: 128,
      },
      key,
      c.unb64u(envelope.ct),
    );
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  }

  async sealCollectionInfo(root:Uint8Array, collectionId:string, keyVersion:number, info:CollectionInfoPlain, fixedNonce?:Uint8Array):Promise<CollectionInfoEnvelope> {
    const c = this.crypto;
    if (info?.v !== 1 || typeof info.name !== 'string' || !info.name.trim() || info.name.length > 200) throw new Error('bad collection info');
    const iv = c.nonce12(fixedNonce);
    const key = await c.aesKey(await c.subkey(root, 'info', collectionId, keyVersion), 'encrypt');
    const ct = new Uint8Array(await c.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.infoAad(collectionId, keyVersion), tagLength: 128 },
      key,
      c.enc.encode(JSON.stringify({ v: 1, name: info.name })),
    ));
    return { format: 'sulla-files-sync-collection-info', v: 1, alg: 'A256GCM', collectionId, keyVersion, nonce: c.b64u(iv), ct: c.b64u(ct) };
  }

  /** Throws on a wrong key, a moved envelope or tampering; callers fall back to a generic name. */
  async openCollectionInfo(root:Uint8Array, envelope:CollectionInfoEnvelope):Promise<CollectionInfoPlain> {
    const c = this.crypto;
    if (envelope?.format !== 'sulla-files-sync-collection-info' || envelope.v !== 1 || envelope.alg !== 'A256GCM') throw new Error('unsupported collection info');
    const key = await c.aesKey(await c.subkey(root, 'info', envelope.collectionId, envelope.keyVersion), 'decrypt');
    const plain = await c.subtle.decrypt(
      { name: 'AES-GCM', iv: c.unb64u(envelope.nonce), additionalData: this.infoAad(envelope.collectionId, envelope.keyVersion), tagLength: 128 },
      key,
      c.unb64u(envelope.ct),
    );
    const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    if (info?.v !== 1 || typeof info.name !== 'string' || !info.name.trim() || info.name.length > 200) throw new Error('bad collection info');
    return { v: 1, name: info.name };
  }

  /** entries = every file's current head in the collection. */
  async stateHash(entries:StateEntry[]):Promise<string> {
    const lines = entries.map(entry => `${ entry.fileId }:${ entry.versionId }:${ entry.deleted ? 1 : 0 }\n`).sort();
    return this.crypto.sha256Hex(this.crypto.enc.encode(lines.join('')));
  }

  async signHead(
    root:Uint8Array,
    input:{ collectionId:string; keyVersion:number; seq:number; stateHash:string; prevMac:string },
  ):Promise<SyncHead> {
    const c = this.crypto;
    if (!Number.isSafeInteger(input.seq) || input.seq < 0) throw new Error('bad seq');
    const head = {
      format: 'sulla-files-sync-head' as const,
      v: 1 as const,
      collectionId: input.collectionId,
      keyVersion: input.keyVersion,
      seq: input.seq,
      stateHash: input.stateHash,
      prevMac: input.prevMac,
    };
    const key = await c.hmacKey(await c.subkey(root, 'head', input.collectionId, input.keyVersion));
    const mac = c.hex(await c.subtle.sign('HMAC', key, this.headMessage(head)));
    return { ...head, mac };
  }

  async verifyHead(root:Uint8Array, head:SyncHead):Promise<boolean> {
    const c = this.crypto;
    if (head?.format !== 'sulla-files-sync-head' || head.v !== 1 || !SyncCryptoPrimitives.hex64.test(head.mac)) return false;
    const key = await c.hmacKey(await c.subkey(root, 'head', head.collectionId, head.keyVersion));
    return c.subtle.verify('HMAC', key, c.view(Buffer.from(head.mac, 'hex')), this.headMessage(head));
  }

  private chunkAad(collectionId:string, keyVersion:number, id:string, flags:number):Bytes {
    return this.crypto.enc.encode(`sulla-fs1|chunk|${ collectionId }|${ keyVersion }|${ id }|${ flags }`);
  }

  private manifestAad(collectionId:string, keyVersion:number, fileId:string, versionId:string):Bytes {
    return this.crypto.enc.encode(`sulla-fs1|manifest|${ collectionId }|${ keyVersion }|${ fileId }|${ versionId }`);
  }

  private infoAad(collectionId:string, keyVersion:number):Bytes {
    return this.crypto.enc.encode(`sulla-fs1|info|${ collectionId }|${ keyVersion }`);
  }

  private headMessage(head:Omit<SyncHead, 'mac'>):Bytes {
    return this.crypto.enc.encode(`sulla-fs1|head|${ head.collectionId }|${ head.keyVersion }|${ head.seq }|${ head.stateHash }|${ head.prevMac }`);
  }
}
