import { createHash } from 'node:crypto';

export const FILES_BOOTSTRAP_VERSION = 1 as const;
export const FILES_BOOTSTRAP_DESTINATION = 'sulla-files' as const;
export type FilesBootstrapDisposition = 'existing' | 'create-new' | 'recover';
export type FilesBootstrapState = 'locked' | 'unlocked' | 'migration-required' | 'error';

export interface FilesBootstrapChallengeRequest {
  callerId: string;
  destination: typeof FILES_BOOTSTRAP_DESTINATION;
  clientNonce: string;
  clientProof: string;
  hasMasterBlob: boolean;
}

export interface FilesBootstrapChallengeResponse {
  challengeId: string;
  serverNonce: string;
  serverProof: string;
  expiresAt: number;
  destination: typeof FILES_BOOTSTRAP_DESTINATION;
  disposition: FilesBootstrapDisposition;
}

export interface FilesBootstrapUnlockRequest {
  callerId: string;
  destination: typeof FILES_BOOTSTRAP_DESTINATION;
  challengeId: string;
  sealedUnlock: string;
  clientProof: string;
}

export interface FilesBootstrapUnlockResponse {
  state: 'unlocked';
  legacyImport: 'clear' | 'imported';
  recovered: boolean;
}

const prefix = 'sulla:files-bootstrap:v1';

export function filesChallengeProofInput(callerId:string, clientNonce:string, hasMasterBlob:boolean):string {
  return `${ prefix }:challenge:${ FILES_BOOTSTRAP_DESTINATION }:${ callerId }:${ clientNonce }:${ hasMasterBlob ? '1' : '0' }`;
}

export function filesServerProofInput(
  callerId:string, clientNonce:string, serverNonce:string, challengeId:string, expiresAt:number,
  disposition:FilesBootstrapDisposition, hasMasterBlob:boolean,
):string {
  return `${ prefix }:server:${ FILES_BOOTSTRAP_DESTINATION }:${ callerId }:${ clientNonce }:${ serverNonce }:${ challengeId }:${ expiresAt }:${ disposition }:${ hasMasterBlob ? '1' : '0' }`;
}

export function filesSessionContext(
  callerId:string, clientNonce:string, serverNonce:string, challengeId:string, expiresAt:number,
  disposition:FilesBootstrapDisposition, hasMasterBlob:boolean,
):string {
  return `${ prefix }:session:${ FILES_BOOTSTRAP_DESTINATION }:${ callerId }:${ clientNonce }:${ serverNonce }:${ challengeId }:${ expiresAt }:${ disposition }:${ hasMasterBlob ? '1' : '0' }`;
}

export function filesUnlockProofInput(
  callerId:string, clientNonce:string, serverNonce:string, challengeId:string, expiresAt:number,
  disposition:FilesBootstrapDisposition, hasMasterBlob:boolean, sealedUnlock:string,
):string {
  const digest = createHash('sha256').update(sealedUnlock, 'utf8').digest('base64url');
  return `${ prefix }:unlock:${ FILES_BOOTSTRAP_DESTINATION }:${ callerId }:${ clientNonce }:${ serverNonce }:${ challengeId }:${ expiresAt }:${ disposition }:${ hasMasterBlob ? '1' : '0' }:${ digest }`;
}
