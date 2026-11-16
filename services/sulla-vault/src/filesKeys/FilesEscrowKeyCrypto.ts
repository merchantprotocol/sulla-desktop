// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Domain-separated Files escrow-key derivation and one-way transport to sulla-files. */
import { webcrypto } from 'node:crypto';

import { FilesCloudEscrowError, type FilesEscrowTransport } from './FilesCloudEscrowError.js';

/**
 * Bodies moved verbatim from the former free functions in filesCloudEscrow.ts
 * (E9). The Web Crypto implementation is injectable; production uses Node's.
 */
export class FilesEscrowKeyCrypto {
  static readonly UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  private static readonly ESCROW_SALT=new TextEncoder().encode('sulla-files-sync-escrow-v1');
  private static readonly TRANSPORT_SALT=new TextEncoder().encode('sulla-files-sync-transport-v1');
  private readonly enc=new TextEncoder();

  constructor(private readonly crypto:typeof webcrypto=webcrypto){}

  async deriveEscrowKey(userKey:Uint8Array,vaultId:string,vaultEpoch:number):Promise<Uint8Array>{
    if(userKey.byteLength!==32||!FilesEscrowKeyCrypto.UUID.test(vaultId)||!Number.isSafeInteger(vaultEpoch)||vaultEpoch<1)throw new FilesCloudEscrowError('invalid_state',409);
    return this.hkdf(userKey,FilesEscrowKeyCrypto.ESCROW_SALT,`${vaultId}|${vaultEpoch}`);
  }

  async transportWrap(key32:Uint8Array,recipientPublicKey:string,requestId:string,vaultId:string,vaultEpoch:number):Promise<FilesEscrowTransport>{
    const subtle=this.crypto.subtle;
    if(key32.byteLength!==32||!FilesEscrowKeyCrypto.UUID.test(requestId))throw new FilesCloudEscrowError('invalid_request',400);
    const recipientBytes=this.unb64u(recipientPublicKey); if(recipientBytes.byteLength!==65)throw new FilesCloudEscrowError('invalid_request',400,'recipientPublicKey is invalid');
    const recipient=await subtle.importKey('raw',recipientBytes,{name:'ECDH',namedCurve:'P-256'},false,[]).catch(()=>{throw new FilesCloudEscrowError('invalid_request',400,'recipientPublicKey is invalid')});
    const eph=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
    const epk=this.b64u(new Uint8Array(await subtle.exportKey('raw',eph.publicKey)));
    const shared=new Uint8Array(await subtle.deriveBits({name:'ECDH',public:recipient},eph.privateKey,256));
    const info=`${requestId}|${vaultId}|${vaultEpoch}`; let wrapping:Uint8Array|undefined;
    try {
      wrapping=await this.hkdf(shared,FilesEscrowKeyCrypto.TRANSPORT_SALT,info);
      const aes=await subtle.importKey('raw',wrapping,{name:'AES-GCM'},false,['encrypt']);
      const iv=this.crypto.getRandomValues(new Uint8Array(12));
      const ct=new Uint8Array(await subtle.encrypt({name:'AES-GCM',iv,additionalData:this.enc.encode(`sulla-fs1|transport|${info}|${epk}`),tagLength:128},aes,key32));
      return {format:'sulla-files-sync-transport',v:1,alg:'ECDH-P256+HKDF-SHA256+A256GCM',epk,nonce:this.b64u(iv),ct:this.b64u(ct)};
    } finally { recipientBytes.fill(0);shared.fill(0);wrapping?.fill(0) }
  }

  private async hkdf(key:Uint8Array,salt:Uint8Array,info:string):Promise<Uint8Array>{
    const subtle=this.crypto.subtle;
    const base=await subtle.importKey('raw',key,'HKDF',false,['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info:this.enc.encode(info)},base,256));
  }

  private b64u(bytes:Uint8Array):string { return Buffer.from(bytes).toString('base64url') }
  private unb64u(value:string):Uint8Array { return new Uint8Array(Buffer.from(value,'base64url')) }
}
