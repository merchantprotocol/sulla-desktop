// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { EscrowTransportRequests } from './escrowTransport.js';
import type { TransportEnvelope } from './envelope.js';
import { HttpStatusError } from './CloudSyncErrors.js';
import { OrgRootKeyCache } from './OrgRootKeyCache.js';
import { isUuid } from './validation.js';

interface OrgSyncRepository {
  enrolledOrgCollection(collectionId:string):Promise<boolean>;
  enableOrgSync(collectionId:string,keyVersion:number):Promise<void>;
}

/** Desktop-only key handoff and adoption of an org collection already present in Cloud. */
export class OrgCollectionCloudSync {
  private readonly transport=new EscrowTransportRequests();
  constructor(private readonly repository:OrgSyncRepository,private readonly keys:OrgRootKeyCache,private readonly changed:(collectionId:string)=>void) {}
  requestTransport():Promise<{requestId:string;recipientPublicKey:string}> { return this.transport.issue() }
  async installRoot(input:{collectionId:string;requestId:string;keyVersion:number;transport:TransportEnvelope}):Promise<void> {
    if(!isUuid(input.collectionId)||!Number.isSafeInteger(input.keyVersion)||input.keyVersion<1) throw new HttpStatusError(400,'organization root request is invalid');
    if(!await this.repository.enrolledOrgCollection(input.collectionId)) throw new HttpStatusError(404,'organization collection not found');
    const root=await this.transport.unwrap(input.requestId,input.transport,input.collectionId,input.keyVersion);
    try { this.keys.set(input.collectionId,input.keyVersion,root) } finally { root.fill(0) }
  }
  async enable(collectionId:string,keyVersion:number,head?:string|null):Promise<{enabled:boolean}> {
    void head;
    if(!isUuid(collectionId)||!Number.isSafeInteger(keyVersion)||keyVersion<1) throw new HttpStatusError(400,'organization sync request is invalid');
    if(!await this.repository.enrolledOrgCollection(collectionId)) throw new HttpStatusError(404,'organization collection not found');
    if(!this.keys.has(collectionId,keyVersion)) throw new HttpStatusError(409,'organization root key is not installed');
    await this.repository.enableOrgSync(collectionId,keyVersion); this.changed(collectionId); return {enabled:true};
  }
}
