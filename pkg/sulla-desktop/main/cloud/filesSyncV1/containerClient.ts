// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Local service clients for Files sync v1. Main only relays metadata and signatures. */
import { loadDesktopApprovalIdentity, desktopVaultFetch } from '@pkg/vault-broker/desktopTransport';
import { getSullaFilesClient, FilesApiError } from '@pkg/main/sullaFilesClient';
import { serviceOrigin } from '@pkg/main/serviceDirectory';

const VAULT = serviceOrigin('vault', 'https');
const files = getSullaFilesClient();

export interface FilesSyncCollectionStatus {
  collectionId:string; name:string; enabled:boolean; status:'off'|'idle'|'syncing'|'error'|'needs-vault';
  lastSyncAt?:string|null; pendingBytes:number; conflicts:number; lastError?:string|null;
}
export interface FilesSyncStatus {
  cryptoModule:{provider:string;version:string;fips:boolean};
  collections:FilesSyncCollectionStatus[];
}
export interface CloudFilesCollection { collectionId:string;status:string;keyVersion:number;headSeq:number;bytes:number;updatedAt:string;sourceDeviceId:string;local:boolean }
export interface PreparedFilesSync { handle:string; op:'create'|'escrow'|'upload-open'|'commit'|'delete'|'info'; collectionId:string; sha256:string }
export interface CloudRestoreAllResult { restored:string[]; failed:Array<{collectionId:string;error:string}> }
export class FilesSyncClientError extends Error {
  constructor(readonly code:string, readonly status:number, message?:string) { super(message || code) }
}
async function filesJson<T>(path:string, init:RequestInit={}):Promise<T> {
  try { return await files.json<T>(path, init) } catch (error) {
    if (error instanceof FilesApiError) throw new FilesSyncClientError(error.message, error.status);
    throw error;
  }
}
async function vaultJson<T>(path:string, body:Record<string,unknown>):Promise<T> {
  const identity=await loadDesktopApprovalIdentity();
  const response=await desktopVaultFetch(`${VAULT}${path}`,{method:'POST',headers:{authorization:`Bearer ${identity.serviceToken}`,'content-type':'application/json','x-sulla-service-id':identity.serviceId},body:JSON.stringify(body)});
  const payload=await response.json().catch(()=>({})) as Record<string,any>;
  if(!response.ok) throw new FilesSyncClientError(String(payload.error||`http_${response.status}`),response.status,payload.message);
  return payload as T;
}
export const FilesSyncContainer={
  status:()=>filesJson<FilesSyncStatus>('/v1/desktop/cloud-sync/status'),
  enable:(collectionId:string,enabled:boolean)=>filesJson<void>(`/v1/desktop/cloud-sync/collections/${encodeURIComponent(collectionId)}/enable`,{method:'POST',body:JSON.stringify({enabled})}),
  deleteCloudCopy:(collectionId:string)=>filesJson<void>(`/v1/desktop/cloud-sync/collections/${encodeURIComponent(collectionId)}/delete-cloud-copy`,{method:'POST'}),
  prepare:()=>filesJson<PreparedFilesSync|null>('/v1/desktop/cloud-sync/prepare',{method:'POST'}),
  send:(handle:string,deviceId:string,ts:number,signature:string)=>filesJson<{status:'sent'|'conflict'|'retry'|'failed';detail?:unknown}>('/v1/desktop/cloud-sync/send',{method:'POST',body:JSON.stringify({handle,deviceId,ts,signature})}),
  escrowRequest:()=>filesJson<{requestId:string;recipientPublicKey:string}>('/v1/desktop/cloud-sync/escrow-key/request',{method:'POST'}),
  escrowKey:(body:{requestId:string;transport:unknown;vaultId:string;vaultEpoch:number})=>filesJson<void>('/v1/desktop/cloud-sync/escrow-key',{method:'POST',body:JSON.stringify(body)}),
  vaultEscrowKey:(body:{requestId:string;recipientPublicKey:string})=>vaultJson<{vaultId:string;vaultEpoch:number;transport:unknown}>('/v1/files/cloud-escrow/key',body),
  vaultRestoreKey:(body:{requestId:string;recipientPublicKey:string})=>vaultJson<{vaultId:string;vaultEpoch:number;transport:unknown}>('/v1/files/cloud-escrow/restore-key',body),
  cloudCollections:()=>filesJson<{collections:CloudFilesCollection[]}>('/v1/desktop/cloud-sync/cloud-collections'),
  restore:(body:{collectionId:string;name:string;requestId:string;transport:unknown;vaultId:string;vaultEpoch:number})=>filesJson<{restored:true;collectionId:string}>('/v1/desktop/cloud-sync/restore',{method:'POST',body:JSON.stringify(body)}),
  restoreAll:(body:{requestId:string;transport:unknown;vaultId:string;vaultEpoch:number})=>filesJson<CloudRestoreAllResult>('/v1/desktop/cloud-sync/restore-all',{method:'POST',body:JSON.stringify(body)}),
};
