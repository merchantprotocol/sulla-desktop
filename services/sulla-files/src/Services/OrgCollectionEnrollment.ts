// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';
import type { Config } from '../config.js';
import type { OrgCollectionEnrollmentRepository } from '../Repositories/OrgCollectionEnrollmentRepository.js';

export type OrgCollectionLevel='none'|'view'|'edit'|'manage';
export interface OrgCollectionEnrollmentInput { collectionId:string;orgId:string;orgName:string;name:string;creatorUserId:string;level:OrgCollectionLevel }

/** Validates cloud enrollment snapshots and provisions local collection key material. */
export class OrgCollectionEnrollment {
  constructor(private readonly db:Pick<pg.Pool,'connect'>,private readonly repository:OrgCollectionEnrollmentRepository,private readonly config:Config) {}
  async enroll(input:OrgCollectionEnrollmentInput):Promise<any> {
    this.validate(input);
    const keyring=this.config.keyring;
    if(!keyring?.unlocked) throw Object.assign(new Error('Files keyring must be unlocked'),{status:423});
    const client=await this.db.connect();
    try {
      await client.query('BEGIN');
      const existing=await client.query('SELECT id FROM collections WHERE id=$1 FOR UPDATE',[input.collectionId]);
      const result=await this.repository.enroll(client,{...input,userId:this.config.userId});
      if(!result) throw Object.assign(new Error('collection enrollment conflicts with existing collection'),{status:409});
      if(!existing.rowCount) { const keys=await keyring.create(input.collectionId,client); await this.repository.setKeys(client,input.collectionId,keys.data,keys.dedup); }
      if(!result) throw Object.assign(new Error('collection enrollment conflicts with existing collection'),{status:409});
      await client.query('COMMIT');
      return result;
    } catch(error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
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
