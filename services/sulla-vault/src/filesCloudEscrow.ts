// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Files Cloud escrow: memory-key wrap, escrow-key transport and Cloud restore unlock. */
import type express from 'express';
import type { CloudSyncAuthority } from './browserEnvelope/syncRunner.js';
import type { FilesAuditEmitter } from './filesAudit.js';
import { DomainVaultSyncCodecProvider } from './browserEnvelope/DomainVaultSyncCodecProvider.js';
import { unwrapMemorySyncKey, wrapMemorySyncKey } from './memorySyncKeyWrap.js';
import { FilesCloudEscrowError, type FilesEscrowTransport } from './filesKeys/FilesCloudEscrowError.js';
import { FilesCloudEscrowRoutes } from './filesKeys/FilesCloudEscrowRoutes.js';
import { FilesEscrowKeyCrypto } from './filesKeys/FilesEscrowKeyCrypto.js';
import { PostgresFilesCloudEscrowRepository } from './repositories/PostgresFilesCloudEscrowRepository.js';

export { FilesCloudEscrowError, type FilesEscrowTransport } from './filesKeys/FilesCloudEscrowError.js';
export { FilesCloudEscrowRoutes } from './filesKeys/FilesCloudEscrowRoutes.js';
export { FilesEscrowKeyCrypto } from './filesKeys/FilesEscrowKeyCrypto.js';
export class FilesCloudEscrowService {
  private restoredCloudKey?:{userKey:Uint8Array;vaultId:string;vaultEpoch:number;expiresAt:number};
  private readonly restoreKeyTtlMs=5*60_000;
  constructor(private readonly authority:CloudSyncAuthority, private readonly repository:PostgresFilesCloudEscrowRepository,
    private readonly audit?:FilesAuditEmitter, private readonly codecProvider:DomainVaultSyncCodecProvider=new DomainVaultSyncCodecProvider(),
    private readonly keyCrypto:FilesEscrowKeyCrypto=new FilesEscrowKeyCrypto()){}
  async wrapMemoryKey(memoryKey:string){
    const raw=new Uint8Array(Buffer.from(memoryKey,'base64'));if(raw.byteLength!==32)throw new FilesCloudEscrowError('invalid_request',400);
    // raw is zeroed even when the vault is locked before the callback runs.
    return this.authority.withUnlockedUserKey(async({userId,userKey,assertCurrent})=>{const wrappedKey=await wrapMemorySyncKey(userKey,userId,raw);assertCurrent();return{wrappedKey}})
      .catch(error=>{if((error as {code?:string}).code==='vault_locked')throw new FilesCloudEscrowError('vault_locked',423);throw error})
      .finally(()=>raw.fill(0));
  }
  async unwrapMemoryKey(wrappedKey:string){
    return this.authority.withUnlockedUserKey(async({userId,userKey,assertCurrent})=>{const raw=await unwrapMemorySyncKey(userKey,userId,wrappedKey);try{assertCurrent();return{memoryKey:Buffer.from(raw).toString('base64')}}finally{raw.fill(0)}})
      .catch(error=>{if((error as {code?:string}).code==='vault_locked')throw new FilesCloudEscrowError('vault_locked',423);throw error});
  }
  async key(requestId:string,recipientPublicKey:string){
    if(!FilesEscrowKeyCrypto.UUID.test(requestId)||typeof recipientPublicKey!=='string'||recipientPublicKey.length>256)throw new FilesCloudEscrowError('invalid_request',400);
    await this.repository.ensureSchema();
    const configured=await this.repository.cloudVaultConfigured();
    if(!configured)throw new FilesCloudEscrowError('no_cloud_vault',409,'This desktop does not hold the Cloud vault.');
    return this.authority.withUnlockedUserKey(async({userId,userKey,assertCurrent})=>{
      const state=await this.repository.findSyncState(userId);
      if(!state)throw new FilesCloudEscrowError('no_cloud_vault',409,'Turn on Passwords sync first; it holds the Files backup keys.');
      const vaultEpoch=Number(state.epoch); const ek=await this.keyCrypto.deriveEscrowKey(userKey,state.vault_id,vaultEpoch);
      try {
        const transport=await this.keyCrypto.transportWrap(ek,recipientPublicKey,requestId,state.vault_id,vaultEpoch); assertCurrent();
        this.audit?.emit({subjectKind:'vault-secret',subjectId:state.vault_id,action:'files_cloud_escrow_key_wrapped',actor:'sulla-vault',result:'allowed',requestId,meta:{vaultEpoch:String(vaultEpoch)}});
        return {vaultId:state.vault_id,vaultEpoch,transport};
      } finally { ek.fill(0) }
    }).catch(error=>{ if((error as {code?:string}).code==='vault_locked')throw new FilesCloudEscrowError('vault_locked',423,'The signed-in encryption session could not be restored.'); throw error });
  }
  clearCloudSessionKey():void { this.restoredCloudKey?.userKey.fill(0); this.restoredCloudKey=undefined }
  async unlockCloud(password:string):Promise<{unlocked:true;expiresAt:number}> {
    if(typeof password!=='string'||password.length<1||password.length>4096)throw new FilesCloudEscrowError('invalid_request',400);
    this.clearCloudSessionKey();
    const status=await this.authority.sullaCloudRequest({method:'GET',path:'/cloud-vault-sync/status',responseType:'json'});
    const statusBody=typeof status.body==='string'?JSON.parse(status.body):status.body as any;
    const vaultId=statusBody?.vaultId;
    if(status.status!==200||typeof vaultId!=='string'||!FilesEscrowKeyCrypto.UUID.test(vaultId))throw new FilesCloudEscrowError('no_cloud_vault',409,'No Passwords backup is available in Sulla Cloud.');
    const fetched=await this.authority.sullaCloudRequest({method:'GET',path:`/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/bundle`,responseType:'json'});
    if(fetched.status!==200)throw new FilesCloudEscrowError('cloud_bundle_unavailable',fetched.status||502);
    const body=typeof fetched.body==='string'?JSON.parse(fetched.body):fetched.body as any;
    const bundle=body?.bundle??body;
    // The cached key is bound to bundle.vaultId/epoch; refuse a bundle for any vault but the one status named.
    if(bundle?.vaultId!==vaultId)throw new FilesCloudEscrowError('cloud_vault_mismatch',409,'The Sulla Cloud backup belongs to a different vault.');
    const envelope=await this.codecProvider.get();
    let userKey:Uint8Array;
    try { userKey=envelope.unlockBundle(bundle,password) }
    catch { throw new FilesCloudEscrowError('wrong_password',401,'That Cloud vault password was not accepted.'); }
    const expiresAt=Date.now()+this.restoreKeyTtlMs;
    this.restoredCloudKey={userKey,vaultId:bundle.vaultId,vaultEpoch:bundle.epoch,expiresAt};
    this.audit?.emit({subjectKind:'vault-secret',subjectId:vaultId,action:'files_cloud_restore_unlocked',actor:'human',result:'allowed',meta:{vaultEpoch:String(bundle.epoch)}});
    return {unlocked:true,expiresAt};
  }
  async restoreKey(requestId:string,recipientPublicKey:string){
    if(!FilesEscrowKeyCrypto.UUID.test(requestId)||typeof recipientPublicKey!=='string'||recipientPublicKey.length>256)throw new FilesCloudEscrowError('invalid_request',400);
    const cached=this.restoredCloudKey;
    if(cached&&cached.expiresAt>Date.now()){
      const ek=await this.keyCrypto.deriveEscrowKey(cached.userKey,cached.vaultId,cached.vaultEpoch);
      try {
        const transport=await this.keyCrypto.transportWrap(ek,recipientPublicKey,requestId,cached.vaultId,cached.vaultEpoch);
        this.audit?.emit({subjectKind:'vault-secret',subjectId:cached.vaultId,action:'files_cloud_restore_key_wrapped',actor:'sulla-vault',result:'allowed',requestId,meta:{vaultEpoch:String(cached.vaultEpoch)}});
        return {vaultId:cached.vaultId,vaultEpoch:cached.vaultEpoch,transport};
      } finally { ek.fill(0); this.clearCloudSessionKey() }
    }
    this.clearCloudSessionKey();
    await this.repository.ensureSchema();
    const configured=await this.repository.cloudVaultConfigured();
    if(!configured)throw new FilesCloudEscrowError('no_cloud_vault',409,'No Passwords backup is available in Sulla Cloud.');
    return this.authority.withUnlockedUserKey(async({userId,userKey,assertCurrent})=>{
      const state=await this.repository.findSyncState(userId);
      if(!state)throw new FilesCloudEscrowError('no_cloud_vault',409,'Turn on Passwords sync first; it holds the Files backup keys.');
      const vaultEpoch=Number(state.epoch); const ek=await this.keyCrypto.deriveEscrowKey(userKey,state.vault_id,vaultEpoch);
      try {
        const transport=await this.keyCrypto.transportWrap(ek,recipientPublicKey,requestId,state.vault_id,vaultEpoch); assertCurrent();
        this.audit?.emit({subjectKind:'vault-secret',subjectId:state.vault_id,action:'files_cloud_restore_key_wrapped',actor:'sulla-vault',result:'allowed',requestId,meta:{vaultEpoch:String(vaultEpoch)}});
        return {vaultId:state.vault_id,vaultEpoch,transport};
      } finally { ek.fill(0) }
    }).catch(error=>{ if((error as {code?:string}).code==='vault_locked')throw new FilesCloudEscrowError('vault_locked',423,'The signed-in encryption session could not be restored.'); throw error });
  }
}
/** @deprecated use FilesEscrowKeyCrypto.deriveEscrowKey — E9 alias, removed in final cleanup */
export function deriveFilesEscrowKey(userKey:Uint8Array,vaultId:string,vaultEpoch:number):Promise<Uint8Array>{
  return new FilesEscrowKeyCrypto().deriveEscrowKey(userKey,vaultId,vaultEpoch);
}
/** @deprecated use FilesEscrowKeyCrypto.transportWrap — E9 alias, removed in final cleanup */
export function transportWrap(key32:Uint8Array,recipientPublicKey:string,requestId:string,vaultId:string,vaultEpoch:number):Promise<FilesEscrowTransport>{
  return new FilesEscrowKeyCrypto().transportWrap(key32,recipientPublicKey,requestId,vaultId,vaultEpoch);
}
/** @deprecated use new FilesCloudEscrowRoutes(...).register(app) — E9 alias, removed in final cleanup */
export function registerFilesCloudEscrowRoute(app:express.Express,service:FilesCloudEscrowService,requireDesktopIdentity:(request:express.Request)=>void,requireHumanSession?:(request:express.Request)=>void):void{
  new FilesCloudEscrowRoutes(service,requireDesktopIdentity,requireHumanSession).register(app);
}
