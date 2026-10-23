/** Domain-separated Files escrow-key derivation and one-way transport to sulla-files. */
import { webcrypto } from 'node:crypto';
import type express from 'express';
import type { Database } from './db.js';
import type { CloudSyncAuthority } from './browserEnvelope/syncRunner.js';
import { ensureSyncSchema } from './browserEnvelope/schema.js';
import type { FilesAuditEmitter } from './filesAudit.js';

const subtle=webcrypto.subtle, enc=new TextEncoder();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const b64u=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64url');
const unb64u=(value:string)=>new Uint8Array(Buffer.from(value,'base64url'));
const ESCROW_SALT=enc.encode('sulla-files-sync-escrow-v1');
const TRANSPORT_SALT=enc.encode('sulla-files-sync-transport-v1');
export interface FilesEscrowTransport {format:'sulla-files-sync-transport';v:1;alg:'ECDH-P256+HKDF-SHA256+A256GCM';epk:string;nonce:string;ct:string}
export class FilesCloudEscrowError extends Error { constructor(readonly code:string,readonly status:number,message?:string){super(message||code)} }
async function hkdf(key:Uint8Array,salt:Uint8Array,info:string):Promise<Uint8Array>{
  const base=await subtle.importKey('raw',key,'HKDF',false,['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info:enc.encode(info)},base,256));
}
export async function deriveFilesEscrowKey(userKey:Uint8Array,vaultId:string,vaultEpoch:number):Promise<Uint8Array>{
  if(userKey.byteLength!==32||!UUID.test(vaultId)||!Number.isSafeInteger(vaultEpoch)||vaultEpoch<1)throw new FilesCloudEscrowError('invalid_state',409);
  return hkdf(userKey,ESCROW_SALT,`${vaultId}|${vaultEpoch}`);
}
export async function transportWrap(key32:Uint8Array,recipientPublicKey:string,requestId:string,vaultId:string,vaultEpoch:number):Promise<FilesEscrowTransport>{
  if(key32.byteLength!==32||!UUID.test(requestId))throw new FilesCloudEscrowError('invalid_request',400);
  const recipientBytes=unb64u(recipientPublicKey); if(recipientBytes.byteLength!==65)throw new FilesCloudEscrowError('invalid_request',400,'recipientPublicKey is invalid');
  const recipient=await subtle.importKey('raw',recipientBytes,{name:'ECDH',namedCurve:'P-256'},false,[]).catch(()=>{throw new FilesCloudEscrowError('invalid_request',400,'recipientPublicKey is invalid')});
  const eph=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
  const epk=b64u(new Uint8Array(await subtle.exportKey('raw',eph.publicKey)));
  const shared=new Uint8Array(await subtle.deriveBits({name:'ECDH',public:recipient},eph.privateKey,256));
  const info=`${requestId}|${vaultId}|${vaultEpoch}`; let wrapping:Uint8Array|undefined;
  try {
    wrapping=await hkdf(shared,TRANSPORT_SALT,info);
    const aes=await subtle.importKey('raw',wrapping,{name:'AES-GCM'},false,['encrypt']);
    const iv=webcrypto.getRandomValues(new Uint8Array(12));
    const ct=new Uint8Array(await subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(`sulla-fs1|transport|${info}|${epk}`),tagLength:128},aes,key32));
    return {format:'sulla-files-sync-transport',v:1,alg:'ECDH-P256+HKDF-SHA256+A256GCM',epk,nonce:b64u(iv),ct:b64u(ct)};
  } finally { recipientBytes.fill(0);shared.fill(0);wrapping?.fill(0) }
}
export class FilesCloudEscrowService {
  constructor(private readonly db:Database,private readonly authority:CloudSyncAuthority,private readonly audit?:FilesAuditEmitter){}
  async key(requestId:string,recipientPublicKey:string){
    if(!UUID.test(requestId)||typeof recipientPublicKey!=='string'||recipientPublicKey.length>256)throw new FilesCloudEscrowError('invalid_request',400);
    await ensureSyncSchema(this.db);
    return this.authority.withUnlockedUserKey(async({userId,userKey,assertCurrent})=>{
      const state=(await this.db.query<{vault_id:string;epoch:number|string}>('SELECT vault_id,epoch FROM cloud_vault_sync_state WHERE owner_user_id=$1',[userId])).rows[0];
      if(!state)throw new FilesCloudEscrowError('no_cloud_vault',409,'Turn on Passwords sync first; it holds the Files backup keys.');
      const vaultEpoch=Number(state.epoch); const ek=await deriveFilesEscrowKey(userKey,state.vault_id,vaultEpoch);
      try {
        const transport=await transportWrap(ek,recipientPublicKey,requestId,state.vault_id,vaultEpoch); assertCurrent();
        this.audit?.emit({subjectKind:'vault-secret',subjectId:state.vault_id,action:'files_cloud_escrow_key_wrapped',actor:'sulla-vault',result:'allowed',requestId,meta:{vaultEpoch:String(vaultEpoch)}});
        return {vaultId:state.vault_id,vaultEpoch,transport};
      } finally { ek.fill(0) }
    }).catch(error=>{ if((error as {code?:string}).code==='vault_locked')throw new FilesCloudEscrowError('vault_locked',423,'Unlock Passwords to back up Files.'); throw error });
  }
}
export function registerFilesCloudEscrowRoute(app:express.Express,service:FilesCloudEscrowService,requireDesktopIdentity:(request:express.Request)=>void):void{
  app.post('/v1/files/cloud-escrow/key',async(request,response)=>{try{requireDesktopIdentity(request);response.setHeader('Cache-Control','no-store');response.json(await service.key(request.body?.requestId,request.body?.recipientPublicKey))}catch(error){const e=error as {status?:number;code?:string;message?:string};response.status(e.status??500).json({error:e.code??'files_cloud_escrow_failed',message:e.message})}});
}
