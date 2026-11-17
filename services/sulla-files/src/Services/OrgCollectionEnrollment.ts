// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Config } from '../config.js';
import type { OrgCollectionEnrollmentRepository } from '../Repositories/OrgCollectionEnrollmentRepository.js';

export type OrgCollectionLevel='none'|'view'|'edit'|'manage';
export interface OrgCollectionEnrollmentInput { collectionId:string;orgId:string;orgName:string;name:string;creatorUserId:string;level:OrgCollectionLevel }

/** Validates cloud enrollment snapshots and provisions local collection key material. */
export class OrgCollectionEnrollment {
  constructor(private readonly repository:OrgCollectionEnrollmentRepository,private readonly config:Config) {}
  async enroll(input:OrgCollectionEnrollmentInput):Promise<any> {
    this.validate(input);
    const keyring=this.config.keyring;
    if(!keyring?.unlocked) throw Object.assign(new Error('Files keyring must be unlocked'),{status:423});
    return this.repository.enroll({...input,userId:this.config.userId},client=>keyring.create(input.collectionId,client));
  }
  async updateLevel(collectionId:string,level:OrgCollectionLevel):Promise<any> {
    if(!this.level(level)) throw Object.assign(new Error('invalid collection level'),{status:400});
    return this.repository.updateLevel(collectionId,this.config.userId,level);
  }
  unenroll(collectionId:string):Promise<boolean> { return this.repository.unenroll(collectionId,this.config.userId) }
  list():Promise<any[]> { return this.repository.list(this.config.userId) }
  private validate(input:OrgCollectionEnrollmentInput):void {
    if(!input.collectionId||!input.orgId||!input.orgName||!input.name||!input.creatorUserId||!this.level(input.level)) throw Object.assign(new Error('invalid organization collection enrollment'),{status:400});
  }
  private level(value:string):value is OrgCollectionLevel { return ['none','view','edit','manage'].includes(value) }
}
