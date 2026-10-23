import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { deriveFilesEscrowKey, transportWrap } from './filesCloudEscrow.js';

const subtle=webcrypto.subtle, enc=new TextEncoder();
const b64u=(b:Uint8Array)=>Buffer.from(b).toString('base64url');
const unb64u=(s:string)=>new Uint8Array(Buffer.from(s,'base64url'));
async function hkdf(ikm:Uint8Array,salt:string,info:string){const base=await subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);return new Uint8Array(await subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:enc.encode(salt),info:enc.encode(info)},base,256))}
// Reference FILES-SYNC-ENVELOPE-v1 transportUnwrap, kept independent of production.
async function referenceUnwrap(env:any,privateKey:CryptoKey,requestId:string,vaultId:string,vaultEpoch:number){
  const peer=await subtle.importKey('raw',unb64u(env.epk),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await subtle.deriveBits({name:'ECDH',public:peer},privateKey,256)); const info=`${requestId}|${vaultId}|${vaultEpoch}`;
  try { const raw=await hkdf(shared,'sulla-files-sync-transport-v1',info); try { const key=await subtle.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']); return new Uint8Array(await subtle.decrypt({name:'AES-GCM',iv:unb64u(env.nonce),additionalData:enc.encode(`sulla-fs1|transport|${info}|${env.epk}`),tagLength:128},key,unb64u(env.ct))) } finally {raw.fill(0)} } finally {shared.fill(0)}
}
test('escrow key derivation opens the published KAT escrow',async()=>{
  const kat={userKey:'fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e0',root:'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',collectionId:'11111111-2222-4333-8444-555555555555',keyVersion:1,vaultId:'01234567-89ab-4cde-8f01-23456789abcd',vaultEpoch:1,escrow:{nonce:'BAQEBAQEBAQEBAQE',ct:'1_z4Kc_z1tlquZZMOsoQF6vydcdIg4GOVBwpS6IoHsampsEyHywTOkViotxmC8pX'}};
  const ek=await deriveFilesEscrowKey(new Uint8Array(Buffer.from(kat.userKey,'hex')),kat.vaultId,kat.vaultEpoch);
  try { const key=await subtle.importKey('raw',ek,{name:'AES-GCM'},false,['decrypt']); const root=await subtle.decrypt({name:'AES-GCM',iv:unb64u(kat.escrow.nonce),additionalData:enc.encode(`sulla-fs1|escrow|${kat.collectionId}|${kat.keyVersion}|${kat.vaultId}|${kat.vaultEpoch}`),tagLength:128},key,unb64u(kat.escrow.ct)); assert.equal(Buffer.from(root).toString('hex'),kat.root) } finally {ek.fill(0)}
});
test('transportWrap interoperates with reference transportUnwrap',async()=>{
  const recipient=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']); const publicKey=b64u(new Uint8Array(await subtle.exportKey('raw',recipient.publicKey)));
  const value=new Uint8Array(32).map((_,i)=>i); const requestId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; const vaultId='01234567-89ab-4cde-8f01-23456789abcd';
  const wrapped=await transportWrap(value,publicKey,requestId,vaultId,1); assert.deepEqual(await referenceUnwrap(wrapped,recipient.privateKey,requestId,vaultId,1),value);
});
