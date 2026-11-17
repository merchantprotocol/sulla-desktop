// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { OrgCollectionKeySource } from './keyStore.js';

export class OrgRootKeyUnavailableError extends Error {
  readonly code='ORG_ROOT_KEY_UNAVAILABLE';
  constructor(readonly collectionId:string,readonly keyVersion:number) { super('organization root key is not installed') }
}

/** Volatile-only storage for roots delivered by a Desktop member's org keyring. */
export class OrgRootKeyCache implements OrgCollectionKeySource {
  private readonly roots=new Map<string,Buffer>();
  async get(collectionId:string,keyVersion:number):Promise<Uint8Array> {
    const root=this.roots.get(this.key(collectionId,keyVersion));
    if(!root) throw new OrgRootKeyUnavailableError(collectionId,keyVersion);
    return Buffer.from(root);
  }
  has(collectionId:string,keyVersion:number):boolean { return this.roots.has(this.key(collectionId,keyVersion)) }
  set(collectionId:string,keyVersion:number,root:Uint8Array):void {
    if(root.byteLength!==32) throw new Error('Invalid organization root key');
    this.clear(collectionId,keyVersion);
    this.roots.set(this.key(collectionId,keyVersion),Buffer.from(root));
  }
  clear(collectionId?:string,keyVersion?:number):void {
    for(const [key,root] of this.roots) {
      if(collectionId!==undefined&&(keyVersion===undefined?!key.startsWith(`${collectionId}:`):key!==this.key(collectionId,keyVersion))) continue;
      root.fill(0); this.roots.delete(key);
    }
  }
  private key(collectionId:string,keyVersion:number):string { return `${collectionId}:${keyVersion}` }
}
