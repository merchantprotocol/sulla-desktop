// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import crypto from 'node:crypto';

export type MemoryStateEntry={id:string;generation:number;deleted:boolean};
export type MemoryEnvelope={version:1;nonce:string;ciphertext:string};
const enc=(value:string)=>Buffer.from(value,'utf8');
export function memoryContentHash(value:unknown):string{return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}
export function advanceMemoryCursor(current:number,records:Array<{seq:number}>,head:{seq:number}|null):number{const candidate=records.at(-1)?.seq??head?.seq??current;return Number.isSafeInteger(candidate)&&candidate>=0?candidate:current}
export function memoryKeySlotWinner(status:number,proposedWrappedKey:string,returnedWrappedKey?:string):string{if(status===201)return proposedWrappedKey;if(status===409&&returnedWrappedKey)return returnedWrappedKey;throw new Error('memory_key_slot_failed')}
export function memoryAad(userId:string,id:string,generation:number):Buffer{return enc(JSON.stringify(['SVmem001',userId,id,generation]))}
export function deriveMemoryMacKey(memoryKey:Buffer):Buffer{return Buffer.from(crypto.hkdfSync('sha256',memoryKey,Buffer.alloc(0),'SVmem001',32))}
export function encryptMemoryRecord(memoryKey:Buffer,userId:string,id:string,generation:number,value:unknown):MemoryEnvelope{
 const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',memoryKey,nonce);cipher.setAAD(memoryAad(userId,id,generation));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final(),cipher.getAuthTag()]);
 if(ciphertext.length<16||ciphertext.length>16*1024)throw new Error('memory_record_size');
 return{version:1,nonce:nonce.toString('base64'),ciphertext:ciphertext.toString('base64')};
}
export function decryptMemoryRecord(memoryKey:Buffer,userId:string,id:string,generation:number,envelope:MemoryEnvelope):unknown{
 if(envelope.version!==1)throw new Error('memory_envelope_version');const nonce=Buffer.from(envelope.nonce,'base64'),raw=Buffer.from(envelope.ciphertext,'base64');
 if(nonce.length<12||raw.length<16)throw new Error('memory_envelope_invalid');const decipher=crypto.createDecipheriv('aes-256-gcm',memoryKey,nonce);decipher.setAAD(memoryAad(userId,id,generation));decipher.setAuthTag(raw.subarray(raw.length-16));
 return JSON.parse(Buffer.concat([decipher.update(raw.subarray(0,-16)),decipher.final()]).toString('utf8'));
}
export function memoryStateHash(entries:MemoryStateEntry[]):string{return crypto.createHash('sha256').update(JSON.stringify([...entries].sort((a,b)=>a.id.localeCompare(b.id)).map(({id,generation,deleted})=>[id,generation,deleted]))).digest('hex')}
export function memoryHeadMac(memoryKey:Buffer,seq:number,stateHash:string,deviceId:string):string{return crypto.createHmac('sha256',deriveMemoryMacKey(memoryKey)).update(JSON.stringify([seq,stateHash,deviceId])).digest('base64')}
export function verifyMemoryHead(memoryKey:Buffer,head:{seq:number;stateHash:string;deviceId:string;mac:string},lastVerifiedSeq:number):void{
 if(head.seq<lastVerifiedSeq)throw new Error('memory_head_rollback');const expected=memoryHeadMac(memoryKey,head.seq,head.stateHash,head.deviceId);if(!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(head.mac)))throw new Error('memory_head_tamper');
}
export function isAuthorityWidening(record:{table:string;value:Record<string,unknown>},foreign:boolean):boolean{return foreign&&(record.value.always_on===true||(record.table==='subject_memory.items'&&record.value.kind==='policy'&&(record.value.ptype==='do'||record.value.ptype==='dont')))}
export type ImportedMemory={id:string;generation:number;deleted:boolean;value?:Record<string,unknown>;pending?:boolean};
export function applyMemoryRecord(current:ImportedMemory|undefined,incoming:ImportedMemory,foreign=false):{active?:ImportedMemory;pending?:ImportedMemory;conflictCopy?:ImportedMemory}{
 if(incoming.deleted)return{active:incoming};
 if(incoming.value&&isAuthorityWidening({table:String(incoming.value.table??''),value:(incoming.value.value??{}) as Record<string,unknown>},foreign))return{active:current,pending:{...incoming,pending:true}};
 if(!current||incoming.generation>current.generation)return{active:incoming};
 if(incoming.generation===current.generation&&JSON.stringify(incoming.value)!==JSON.stringify(current.value))return{active:incoming,conflictCopy:{...current,id:`${current.id}:conflict`,value:{...current.value,superseded_by:incoming.id}}};
 return{active:current};
}
