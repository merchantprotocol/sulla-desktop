// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { OrgCollectionKeySource } from './keyStore.js';
import { UNSCOPED_PROFILE_ID } from '../ProfileIdentity.js';

export class OrgRootKeyUnavailableError extends Error {
  readonly code='ORG_ROOT_KEY_UNAVAILABLE';
  constructor(readonly collectionId:string,readonly keyVersion:number) { super('organization root key is not installed') }
}

/**
 * Volatile-only storage for roots delivered by a Desktop member's org keyring.
 * Roots are partitioned by Cloud profile: a read only sees the profile active now.
 */
export class OrgRootKeyCache implements OrgCollectionKeySource {
  private readonly profiles=new Map<string,Map<string,Buffer>>();
  constructor(private readonly profileOf:()=>string=()=>UNSCOPED_PROFILE_ID) {}
  async get(collectionId:string,keyVersion:number):Promise<Uint8Array> {
    const root=this.current().get(this.key(collectionId,keyVersion));
    if(!root) throw new OrgRootKeyUnavailableError(collectionId,keyVersion);
    return Buffer.from(root);
  }
  has(collectionId:string,keyVersion:number):boolean { return this.current().has(this.key(collectionId,keyVersion)) }
  set(collectionId:string,keyVersion:number,root:Uint8Array):void {
    if(root.byteLength!==32) throw new Error('Invalid organization root key');
    this.clear(collectionId,keyVersion);
    this.current().set(this.key(collectionId,keyVersion),Buffer.from(root));
  }
  /** No arguments clears every profile (stop/lock). Collection arguments clear only the active profile. */
  clear(collectionId?:string,keyVersion?:number):void {
    if(collectionId===undefined) { for(const profileId of [...this.profiles.keys()]) this.invalidateProfile(profileId); return }
    this.zeroize(this.current(),collectionId,keyVersion);
  }
  /** Zeroizes and forgets one profile's roots; other profiles are untouched. */
  invalidateProfile(profileId:string):void {
    const roots=this.profiles.get(profileId);
    if(!roots) return;
    this.zeroize(roots);
    this.profiles.delete(profileId);
  }
  private current():Map<string,Buffer> {
    const profileId=this.profileOf();
    let roots=this.profiles.get(profileId);
    if(!roots) { roots=new Map(); this.profiles.set(profileId,roots) }
    return roots;
  }
  private zeroize(roots:Map<string,Buffer>,collectionId?:string,keyVersion?:number):void {
    for(const [key,root] of roots) {
      if(collectionId!==undefined&&(keyVersion===undefined?!key.startsWith(`${collectionId}:`):key!==this.key(collectionId,keyVersion))) continue;
      root.fill(0); roots.delete(key);
    }
  }
  private key(collectionId:string,keyVersion:number):string { return `${collectionId}:${keyVersion}` }
}
