// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import { getConfiguredApprovalClient } from '@pkg/vault-broker';
import { getDesktopDeviceId } from '../deviceIdentity';
import { getCurrentUserId } from '../sullaCloudAuth';
import { cloudRequest } from './cloudFetch';
import { signDeviceMessage } from './deviceKey';

export type EnrollmentDisposition='create'|'trusted'|'adopted'|'waiting'|'recovery';
type State={state:'no_vault'|'trusted'|'approval_available'|'waiting_for_approver'|'recovery_required';vaultId?:string;epoch?:number};
let pending:Promise<EnrollmentDisposition>|null=null;
let activeRequest:{id:string;vaultId:string;epoch:number;privateKeyJwk:JsonWebKey}|null=null;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function signed(method:string,path:string,vaultId:string,op:string,body?:unknown):Promise<Response>{
 const userId=await getCurrentUserId(),deviceId=await getDesktopDeviceId();
 const bytes=body===undefined?Buffer.alloc(0):Buffer.from(JSON.stringify(body));
 const hash=crypto.createHash('sha256').update(bytes).digest('hex');
 const proof=signDeviceMessage('vault-sync-v3',[userId,deviceId,vaultId,op,hash]);
 const separator=path.includes('?')?'&':'?';
 return cloudRequest(method,`${path}${separator}deviceId=${encodeURIComponent(deviceId)}`,{headers:{'X-Sulla-Timestamp':String(proof.ts),'X-Sulla-Device-Signature':proof.signature,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:bytes,responseType:'json'});
}
async function state():Promise<State>{
 const deviceId=await getDesktopDeviceId();
 const status=await cloudRequest('GET',`/cloud-vault-sync/status?deviceId=${encodeURIComponent(deviceId)}`,{responseType:'json'});
 const summary=await status.json() as {enabled?:boolean;vaultId?:string};
 if(!summary.enabled||!summary.vaultId)return{state:'no_vault'};
 const response=await signed('GET','/cloud-vault-sync/enrollment/state',summary.vaultId,'enrollment-state');
 if(!response.ok)throw new Error(`enrollment_state_${response.status}`);
 return response.json() as Promise<State>;
}
async function enroll(s:State,masterKey:Uint8Array,cloudUserId:string):Promise<EnrollmentDisposition>{
 const vaultId=s.vaultId!,epoch=s.epoch!;
 const pair=activeRequest?null:await globalThis.crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']) as CryptoKeyPair|null;
 const publicKey=pair?Buffer.from(await globalThis.crypto.subtle.exportKey('raw',pair.publicKey)).toString('base64url'):'';
 const privateKeyJwk=pair?await globalThis.crypto.subtle.exportKey('jwk',pair.privateKey):activeRequest!.privateKeyJwk;
 const nonce=crypto.randomBytes(16).toString('base64url');
 const opened=activeRequest?null:await signed('POST',`/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/enrollment/requests`,vaultId,'enrollment-request',{publicKey,nonce});
 if(opened&&!opened.ok&&opened.status!==409)throw new Error(`enrollment_request_${opened.status}`);
 let request=activeRequest?.vaultId===vaultId?activeRequest:null;
 if(!request&&opened?.ok){const created=await opened.json() as {id:string;vaultId:string;epoch:number}; activeRequest={...created,privateKeyJwk}; request=activeRequest;}
 if(!request)return'waiting';
 for(let attempt=0;attempt<60;attempt++){
  await sleep(5_000);
  const consumed=await signed('POST',`/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/enrollment/requests/${encodeURIComponent(request.id)}/consume`,vaultId,`enrollment-consume:${request.id}`,{});
  if(consumed.status===409)continue;
  if(!consumed.ok)throw new Error(`enrollment_consume_${consumed.status}`);
  const {wrappedUserKey}=await consumed.json() as {wrappedUserKey:unknown};
  const client=getConfiguredApprovalClient(); if(!client)throw new Error('vault enrollment service unavailable');
  const proof=await client.adoptVaultEnrollment({requestId:request.id,vaultId,vaultEpoch:epoch,privateKeyJwk,wrappedUserKey,masterKey:Buffer.from(masterKey).toString('base64url'),cloudUserId});
  const confirmed=await signed('POST',`/cloud-vault-sync/vaults/${encodeURIComponent(vaultId)}/enrollment/requests/${encodeURIComponent(request.id)}/confirm`,vaultId,`enrollment-confirm:${request.id}`,proof);
  if(!confirmed.ok)throw new Error(`enrollment_confirm_${confirmed.status}`);
  await client.commitVaultEnrollment(request.id);
  const { onVaultUnlocked }=await import('@pkg/sulla'); await onVaultUnlocked();
  activeRequest=null; return'adopted';
 }
 throw new Error('enrollment_timeout');
}
export async function gateVaultCreation(masterKey:Uint8Array,cloudUserId:string):Promise<EnrollmentDisposition>{
 pending??=(async()=>{const s=await state();if(s.state==='no_vault')return'create';if(s.state==='trusted')return'trusted';if(s.state==='recovery_required')return'recovery';return enroll(s,masterKey,cloudUserId)})().finally(()=>{pending=null});
 return pending;
}
export { signed as signedEnrollmentRequest };
