// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import { getConfiguredApprovalClient } from '@pkg/vault-broker';
import { getDesktopDeviceId } from '../deviceIdentity';
import { getCurrentUserId } from '../sullaCloudAuth';
import { cloudRequest } from './cloudFetch';
import { CloudVaultSyncHttpTransport, VaultSyncHttpError, type EnrollmentState, type EnrollmentRequest, type VaultSyncSignature } from './vaultSyncV3/transport';
import { signDeviceMessage } from './deviceKey';

export type EnrollmentDisposition='create'|'trusted'|'adopted'|'approval_available'|'waiting_for_approver'|'recovery';
type State = EnrollmentState;
let pending:Promise<EnrollmentDisposition>|null=null;
let prepared:Promise<State>|null=null;
let preparedForUserId='';
let activeRequest:(EnrollmentRequest & {vaultId:string;epoch:number;privateKeyJwk:JsonWebKey})|null=null;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function transport(): CloudVaultSyncHttpTransport {
 return new CloudVaultSyncHttpTransport({ client:{request:(url,init)=>cloudRequest(init?.method ?? 'GET',url,{headers:init?.headers as Record<string,string>|undefined,body:init?.body as BodyInit|undefined,responseType:'json'})}, authHeaders:async()=>({}) });
}
function signature(vaultId:string, op:string, body:unknown, deviceId:string, userId:string):VaultSyncSignature {
 const bytes=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));
 const hash=crypto.createHash('sha256').update(bytes).digest('hex');
 const proof=signDeviceMessage('vault-sync-v3',[userId,deviceId,vaultId,op,hash]);
 return {deviceId,timestamp:proof.ts,signature:proof.signature};
}
async function state():Promise<State>{
 const deviceId=await getDesktopDeviceId();
 const status=await transport().getStatus(deviceId);
 if(!status.enabled||!status.vaultId)return{state:'no_vault'};
 return transport().getEnrollmentState(status.vaultId, signature(status.vaultId,'enrollment-state',undefined,deviceId,await getCurrentUserId()));
}
async function openRequest(s:State):Promise<void>{
 const vaultId=s.vaultId!,epoch=s.epoch!, deviceId=await getDesktopDeviceId(), userId=await getCurrentUserId();
 if(activeRequest?.vaultId===vaultId)return;
 const pair=await globalThis.crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']) as CryptoKeyPair;
 const publicKey=pair?Buffer.from(await globalThis.crypto.subtle.exportKey('raw',pair.publicKey)).toString('base64url'):'';
 const privateKeyJwk=await globalThis.crypto.subtle.exportKey('jwk',pair.privateKey);
 const nonce=crypto.randomBytes(16).toString('base64url');
 const body={publicKey,nonce};
 try {
  const created=await transport().openEnrollmentRequest(vaultId,body,signature(vaultId,'enrollment-request',body,deviceId,userId));
  activeRequest={...created, vaultId, epoch, privateKeyJwk};
 } catch(error) {
  if(!(error instanceof VaultSyncHttpError) || error.status!==409)throw error;
 }
}
async function enroll(s:State,masterKey:Uint8Array,cloudUserId:string):Promise<EnrollmentDisposition>{
 const vaultId=s.vaultId!,epoch=s.epoch!; await openRequest(s);
 const request=activeRequest?.vaultId===vaultId?activeRequest:null;
 if(!request)return s.state==='approval_available'?'approval_available':'waiting_for_approver';
 const deviceId=await getDesktopDeviceId();
 for(let attempt=0;attempt<60;attempt++){
  await sleep(5_000);
  let consumed; try { consumed=await transport().consumeEnrollmentRequest(vaultId,request.id,signature(vaultId,`enrollment-consume:${request.id}`,{},deviceId,cloudUserId)); } catch(error) { if(error instanceof VaultSyncHttpError && error.status===409)continue; throw error; }
  const {wrappedUserKey}=consumed;
  const client=getConfiguredApprovalClient(); if(!client)throw new Error('vault enrollment service unavailable');
  const proof=await client.adoptVaultEnrollment({requestId:request.id,vaultId,vaultEpoch:epoch,privateKeyJwk:request.privateKeyJwk,wrappedUserKey,masterKey:Buffer.from(masterKey).toString('base64url'),cloudUserId});
  await transport().confirmEnrollmentRequest(vaultId,request.id,proof,signature(vaultId,`enrollment-confirm:${request.id}`,proof,deviceId,cloudUserId));
  await client.commitVaultEnrollment(request.id);
  const { onVaultUnlocked }=await import('@pkg/sulla'); await onVaultUnlocked(); activeRequest=null; return'adopted';
 }
 throw new Error('enrollment_timeout');
}
/** Ask Cloud about the signed-in account before any local-vault create path runs. */
export async function gateVaultCreation():Promise<EnrollmentDisposition>{
 const userId=await getCurrentUserId();
 if(!userId)throw new Error('enrollment_requires_cloud_session');
 if(preparedForUserId!==userId){preparedForUserId=userId;prepared=null;activeRequest=null;}
 // Never cache a failure: a lookup made before the vault broker or network
 // is answering would otherwise fail every later retry for the whole run
 // (seen on a fresh iMac first run: vault creation refused for minutes).
 if(!prepared){
  const lookup=state().then(async s=>{
   if(s.state==='approval_available'||s.state==='waiting_for_approver')await openRequest(s);
   return s;
  });
  prepared=lookup;
  lookup.catch(()=>{if(prepared===lookup)prepared=null;});
 }
 const s=await prepared;
 if(s.state==='no_vault')return'create';
 if(s.state==='trusted')return'trusted';
 if(s.state==='recovery_required')return'recovery';
 return s.state;
}
export async function completeVaultEnrollment(masterKey:Uint8Array,cloudUserId:string):Promise<EnrollmentDisposition>{
 pending??=(async()=>{const disposition=await gateVaultCreation();if(disposition!=='approval_available'&&disposition!=='waiting_for_approver')return disposition;return enroll(await prepared!,masterKey,cloudUserId)})().finally(()=>{pending=null});
 return pending;
}
