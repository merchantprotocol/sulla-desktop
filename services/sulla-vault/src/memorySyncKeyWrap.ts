// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { webcrypto } from 'node:crypto';

const subtle=webcrypto.subtle,enc=new TextEncoder(),AAD_PREFIX='SVmemkey001';
export async function wrapMemorySyncKey(userKey:Uint8Array,userId:string,memoryKey:Uint8Array):Promise<string>{
  if(userKey.byteLength!==32||memoryKey.byteLength!==32||!userId)throw new Error('invalid_request');
  const aes=await subtle.importKey('raw',userKey,{name:'AES-GCM'},false,['encrypt']),nonce=webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext=new Uint8Array(await subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:enc.encode(`${AAD_PREFIX}|${userId}`),tagLength:128},aes,memoryKey));
  return Buffer.concat([Buffer.from(nonce),Buffer.from(ciphertext)]).toString('base64');
}
export async function unwrapMemorySyncKey(userKey:Uint8Array,userId:string,wrappedKey:string):Promise<Uint8Array>{
  if(userKey.byteLength!==32||!userId||typeof wrappedKey!=='string'||wrappedKey.length>4096)throw new Error('invalid_request');
  const packed=Buffer.from(wrappedKey,'base64');if(packed.byteLength!==60)throw new Error('invalid_request');
  const aes=await subtle.importKey('raw',userKey,{name:'AES-GCM'},false,['decrypt']);
  try{return new Uint8Array(await subtle.decrypt({name:'AES-GCM',iv:packed.subarray(0,12),additionalData:enc.encode(`${AAD_PREFIX}|${userId}`),tagLength:128},aes,packed.subarray(12)))}catch{throw new Error('memory_key_unwrap_failed')}
}
