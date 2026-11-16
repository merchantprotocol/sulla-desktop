// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash, timingSafeEqual } from 'node:crypto';

import { deriveLoginHash, type FilesTransportEnvelope as TransportEnvelope } from '@sulla/vault-crypto';

import { makeLoginVerifier } from '../auth.js';
import type { SyncBundle, SyncHead } from '../browserEnvelope/envelope.js';
import type { VaultDeviceApprovalWrapRequest, VaultEnrollmentAdoptRequest, VaultEnrollmentWrapRequest } from '../contracts.js';
import { transportWrap } from '../filesCloudEscrow.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * Device enrollment hand-offs: wraps the unlocked user key for an approved Cloud enrollment or
 * device-approval request, and adopts/commits a vault received from another device.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class VaultEnrollmentService {
  constructor(private readonly host: LocalAuthorityHost) {}

  async wrapVaultEnrollment(serviceId:string, token:string|undefined, input:VaultEnrollmentWrapRequest):Promise<{wrappedUserKey:TransportEnvelope}> {
    this.host.requireApprovalIdentity(serviceId, token);
    if (input?.approved !== true) throw new LocalVaultError('approval_required', 428, 'Vault enrollment was not approved');
    const keys=this.host.requireKeys();
    const env=await this.host.codecProvider.get();
    const bundle=input.bundle as SyncBundle, head=input.head as SyncHead;
    env.verifyBundle(bundle,keys.userKey);
    if(head?.vaultId!==input.vaultId||head.scope!=='personal')throw new LocalVaultError('invalid_operation',409,'Cloud head does not match this vault');
    const payload=Buffer.from(JSON.stringify({userKey:Buffer.from(keys.userKey).toString('base64url'),bundle,head,...(input.records===undefined?{}:{records:input.records})}));
    try{return{wrappedUserKey:await this.host.filesTransport.wrap(payload,input.publicKey,input.requestId,input.vaultId,input.vaultEpoch)}}finally{payload.fill(0)}
  }

  async adoptVaultEnrollment(serviceId:string, token:string|undefined, input:VaultEnrollmentAdoptRequest):Promise<{bundleMac:string;headMac:string}> {
    this.host.requireApprovalIdentity(serviceId,token);
    if(!await this.host.isSetupRequired())throw new LocalVaultError('vault_exists',409,'A local vault already exists');
    const masterKey=Buffer.from(input.masterKey||'','base64url');
    if(masterKey.byteLength!==32)throw new LocalVaultError('invalid_unlock_material',400,'Account master key is invalid');
    let userKey:Uint8Array|undefined, privateKey:Uint8Array|undefined, plain:Uint8Array|undefined;
    try{
      const e=input.wrappedUserKey as TransportEnvelope;
      const recipient=await globalThis.crypto.subtle.importKey('jwk',input.privateKeyJwk,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
      plain=await this.host.filesTransport.unwrap(e,recipient,input.requestId,input.vaultId,input.vaultEpoch);
      const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)) as {userKey:string;bundle:SyncBundle;head:SyncHead};
      userKey=Buffer.from(payload.userKey,'base64url'); if(userKey.byteLength!==32)throw new Error('bad user key');
      const env=await this.host.codecProvider.get(); env.verifyBundle(payload.bundle,userKey);
      if(payload.head?.vaultId!==input.vaultId||payload.head.scope!=='personal')throw new Error('bad head');
      const wrapped=(await this.host.keyEnvelopeReaderProvider.get()).unwrapUserKey(payload.bundle.encryptedUserKey,masterKey); if(!timingSafeEqual(Buffer.from(wrapped),Buffer.from(userKey)))throw new Error('bundle key mismatch'); wrapped.fill(0);
      privateKey=(await this.host.keyEnvelopeReaderProvider.get()).unwrapUserPrivateKey(payload.bundle.encryptedPrivateKey,userKey);
      this.host.pendingVaultEnrollments.set(input.requestId,{expiresAt:Date.now()+60_000,bundle:payload.bundle,head:payload.head,userKey:Uint8Array.from(userKey),privateKey:Uint8Array.from(privateKey),masterKey:Uint8Array.from(masterKey),cloudUserId:input.cloudUserId});
      return{bundleMac:payload.bundle.mac,headMac:payload.head.mac};
    }catch(error){throw error instanceof LocalVaultError?error:new LocalVaultError('invalid_proof',403,'Vault enrollment could not be verified')}finally{masterKey.fill(0);userKey?.fill(0);privateKey?.fill(0);plain?.fill(0)}
  }

  async commitVaultEnrollment(serviceId:string,token:string|undefined,requestId:string):Promise<{adopted:true}>{
    this.host.requireApprovalIdentity(serviceId,token); const staged=this.host.pendingVaultEnrollments.get(requestId); this.host.pendingVaultEnrollments.delete(requestId);
    if(!staged||staged.expiresAt<Date.now())throw new LocalVaultError('invalid_operation',409,'Vault enrollment expired');
    try{ if(!await this.host.isSetupRequired())throw new LocalVaultError('vault_exists',409,'A local vault already exists'); const b=staged.bundle;
      const verifier=makeLoginVerifier(await deriveLoginHash(staged.masterKey));
      await this.host.runTransaction(async client => {
        await this.host.userRepository.createWithId([
          b.vaultUserId,
          verifier.salt,
          verifier.verifier,
          b.publicKey,
          b.encryptedPrivateKey,
          b.encryptedUserKey,
          { authority: 'container', version: 1, cloudUserId: staged.cloudUserId, password: { salt: b.kdf.salt, parameters: { memoryBytes: b.kdf.memoryBytes, operations: b.kdf.ops } } },
        ], client);
        await this.host.syncStateRepository.create([
          b.vaultUserId,
          b.vaultId,
          b.epoch,
          b.bundleGeneration,
          createHash('sha256').update(JSON.stringify(b)).digest('hex'),
        ], client);
      });
      this.host.lockNow();this.host.keys={userId:b.vaultUserId,publicKey:b.publicKey,userKey:Uint8Array.from(staged.userKey),privateKey:Uint8Array.from(staged.privateKey)};this.host.generation+=1;this.host.migrationState='unlocked';this.host.stageCacheUpdate(staged.masterKey);return{adopted:true};
    }finally{staged.userKey.fill(0);staged.privateKey.fill(0);staged.masterKey.fill(0)}
  }

  /** Build a reset relay envelope only after the native approval prompt returned an explicit tap. */
  async wrapUserKeyForApprovedDevice(
    serviceId: string, token: string | undefined, input: VaultDeviceApprovalWrapRequest,
  ): Promise<{ wrappedUserKey: Awaited<ReturnType<typeof transportWrap>> }> {
    this.host.requireApprovalIdentity(serviceId, token);
    if (input?.approved !== true) throw new LocalVaultError('approval_required', 428, 'Vault access was not approved');
    const keys = this.host.requireKeys();
    const state = await this.host.syncStateRepository.find<{ vault_id: string; epoch: number | string }>(keys.userId);
    const row = state.rows[0];
    if (!row || row.vault_id !== input.vaultId || Number(row.epoch) !== input.vaultEpoch) {
      throw new LocalVaultError('invalid_operation', 409, 'Approval request does not match this vault');
    }
    return { wrappedUserKey: await transportWrap(keys.userKey, input.publicKey, input.requestId, input.vaultId, input.vaultEpoch) };
  }
}
