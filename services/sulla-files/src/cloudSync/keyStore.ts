// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes } from 'node:crypto';

import { decrypt, encrypt, type Envelope } from '../crypto.js';
import type { FilesKeyring } from '../keyring.js';

function context(collectionId:string, keyVersion:number):string {
  return `sulla:files:cloud-root:v1:${ collectionId }:${ keyVersion }`;
}

/**
 * Local at-rest storage for the cloud sync root key R. R is wrapped with the
 * collection's random data key, which FilesKeyring itself keeps only under the
 * Files master. This envelope never leaves the VM; nothing here reaches Cloud.
 */
export class CloudRootKeyStore {
  constructor(private readonly keyring:Pick<FilesKeyring, 'keys'>) {}

  /** Caller owns the returned root and must zero it. */
  async create(collectionId:string, keyVersion:number):Promise<{ root:Buffer; wrapped:Envelope }> {
    const root = randomBytes(32);
    try {
      return { root, wrapped: await this.wrap(collectionId, keyVersion, root) };
    } catch (error) {
      root.fill(0);
      throw error;
    }
  }

  async wrap(collectionId:string, keyVersion:number, root:Uint8Array):Promise<Envelope> {
    const keys = await this.keyring.keys(collectionId);
    return encrypt(root, keys.data, context(collectionId, keyVersion));
  }

  /** Caller owns the returned root and must zero it. */
  async unwrap(collectionId:string, keyVersion:number, wrapped:Envelope):Promise<Buffer> {
    const keys = await this.keyring.keys(collectionId);
    const root = await decrypt(wrapped, keys.data, context(collectionId, keyVersion));
    if (root.length !== 32) {
      root.fill(0);
      throw new Error('Invalid cloud sync root key');
    }
    const copy = Buffer.from(root);
    root.fill(0);
    return copy;
  }
}


/** Root-key source contract. Organization keys are supplied by Desktop's org keyring, never Vault escrow. */
export interface CollectionRootKeyProvider {
  create(collectionId:string,keyVersion:number):Promise<{root:Buffer;wrapped:Envelope}>;
  wrap(collectionId:string,keyVersion:number,root:Uint8Array):Promise<Envelope>;
  unwrap(collectionId:string,keyVersion:number,wrapped:Envelope):Promise<Buffer>;
}

/** Existing per-user Files keyring behavior. */
export class LocalEscrowRootKeyProvider extends CloudRootKeyStore implements CollectionRootKeyProvider {}

export interface OrgCollectionKeySource { get(collectionId:string,keyVersion:number):Promise<Uint8Array> }

/** Organization roots are acquired from an injected keyring port; there is deliberately no escrow fallback. */
export class OrgRootKeyProvider implements CollectionRootKeyProvider {
  constructor(private readonly source:OrgCollectionKeySource) {}
  async create(collectionId:string,keyVersion:number):Promise<{root:Buffer;wrapped:Envelope}> {
    const supplied=await this.source.get(collectionId,keyVersion); const root=Buffer.isBuffer(supplied)?supplied:Buffer.from(supplied);
    if(root.length!==32) { root.fill(0); throw new Error('Invalid organization root key') }
    return {root,wrapped:await this.wrap(collectionId,keyVersion,root)};
  }
  async wrap(_collectionId:string,_keyVersion:number,root:Uint8Array):Promise<Envelope> {
    if(root.length!==32) throw new Error('Invalid organization root key');
    // Marker only: the root itself is held by the org keyring and is never escrowed here.
    return {version:1,algorithm:'xchacha20-poly1305',nonce:'org-key-source',ciphertext:'org-key-source'};
  }
  async unwrap(collectionId:string,keyVersion:number,_wrapped:Envelope):Promise<Buffer> {
    const supplied=await this.source.get(collectionId,keyVersion); const root=Buffer.isBuffer(supplied)?supplied:Buffer.from(supplied);
    if(root.length!==32) { root.fill(0); throw new Error('Invalid organization root key') }
    return root;
  }
}


/** Chooses the root-key authority from the collection's persisted source; organization failures never fall back to Vault escrow. */
export interface CollectionRootKeySourceRepository { rootKeySource(collectionId:string):Promise<string|undefined> }

export class CollectionVaultEscrowPolicy {
  constructor(private readonly sources:CollectionRootKeySourceRepository) {}
  async assertAllowed(collectionId:string):Promise<void> {
    const source=await this.sources.rootKeySource(collectionId);
    if(source==='org') throw Object.assign(new Error('Organization collection roots cannot use Vault escrow'),{status:403});
    if(source!=='local') throw Object.assign(new Error('Cloud sync collection not found'),{status:404});
  }
}

export class CollectionRootKeyProviderSelector implements CollectionRootKeyProvider {
  constructor(private readonly sources:CollectionRootKeySourceRepository,private readonly local:CollectionRootKeyProvider,private readonly organization:CollectionRootKeyProvider) {}
  private async provider(collectionId:string):Promise<CollectionRootKeyProvider> {
    const source=await this.sources.rootKeySource(collectionId);
    if(!source) throw new Error('Cloud sync collection not found');
    if(source==='org') return this.organization;
    if(source==='local') return this.local;
    throw new Error('Unsupported collection root key source');
  }
  async create(collectionId:string,keyVersion:number) { return (await this.provider(collectionId)).create(collectionId,keyVersion) }
  async wrap(collectionId:string,keyVersion:number,root:Uint8Array) { return (await this.provider(collectionId)).wrap(collectionId,keyVersion,root) }
  async unwrap(collectionId:string,keyVersion:number,wrapped:Envelope) { return (await this.provider(collectionId)).unwrap(collectionId,keyVersion,wrapped) }
}
