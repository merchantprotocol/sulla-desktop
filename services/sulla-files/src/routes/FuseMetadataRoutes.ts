// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import type { FilesIdentity } from '../auth.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate, RequestWithIdentity, Right } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { FileMetadataRepository, MetadataTable } from '../Repositories/FileMetadataRepository.js';

const { cleanPath } = FilesRequestInput;

/** Files-mount metadata (moved from app.ts): read and revision-checked write of file/folder metadata, and a folder's child metadata. */
export class FuseMetadataRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly access:FilesAccessGate,
    private readonly transactions:TransactionRunner,
    private readonly metadata:FileMetadataRepository,
  ) {}

  register(app:express.Express):void {
    app.get('/v1/fuse/metadata',async(request:RequestWithIdentity,response,next)=>{try{
      const collectionId=String(request.query.collectionId??''); const path=cleanPath(request.query.path);
      const target=await this.metadataTarget(request,collectionId,path,'view');
      response.json({path,kind:target.kind,metadata:this.metadataValue(target.row,target.kind==='folder'),revision:Number(target.row.metadata_revision)});
    }catch(error){next(error)}});
    app.put('/v1/fuse/metadata',async(request:RequestWithIdentity,response,next)=>{try{
      const collectionId=String(request.body.collectionId??''); const path=cleanPath(request.body.path); const actor=this.access.identity(request);
      const set=request.body.set??{},unset=request.body.unset??[];
      if(!set||typeof set!=='object'||Array.isArray(set)||!Array.isArray(unset)||unset.some((key:unknown)=>typeof key!=='string')) throw new HttpError(400,'set must be an object and unset must be a string array');
      const keys=[...Object.keys(set),...unset];
      if(keys.some(key=>!key||key.length>128||key.includes('\0'))) throw new HttpError(400,'invalid metadata key');
      if(keys.some(key=>!this.canWriteMetadata(actor,key))) throw new HttpError(403,'metadata field is not writable by this actor');
      const updatedTarget=await this.transactions.run('metadata-write',async client=>{ const target=await this.metadataTarget(request,collectionId,path,'edit',client);
      if(request.body.baseRevision!==undefined&&Number(request.body.baseRevision)!==Number(target.row.metadata_revision)) throw new HttpError(409,'metadata revision changed');
      const old=this.metadataValue(target.row,target.kind==='folder'); const next={...old,...set}; for(const key of unset) delete next[key];
      const table:MetadataTable=target.kind==='file'?'files':'file_folders';
      if(target.kind==='folder'){
        const description=Object.hasOwn(next,'description')?next.description:null,namingHint=Object.hasOwn(next,'naming_hint')?next.naming_hint:null;
        if(description!==null&&typeof description!=='string'||namingHint!==null&&typeof namingHint!=='string') throw new HttpError(400,'folder description and naming_hint must be strings');
        delete next.description; delete next.naming_hint;
        await this.metadata.setFolderMetadata(client,table,target.row.id,next,description,namingHint);
      }else await this.metadata.setMetadata(client,table,target.row.id,next);
      const updated=await this.metadata.row(client,table,target.row.id);
      for(const key of keys) if(JSON.stringify(old[key])!==JSON.stringify(this.metadataValue(updated,target.kind==='folder')[key])) await this.metadata.auditChange(client,
        actor.agentId?'agent':actor.kind==='capability'?'agent-or-device':'user',actor.agentId??actor.userId,actor.jobId??actor.deviceId??null,target.kind==='file'?target.row.id:null,{key,old:old[key]??null,new:this.metadataValue(updated,target.kind==='folder')[key]??null,collectionId,path});
      return {updated,kind:target.kind}; });
      response.json({revision:Number(updatedTarget.updated.metadata_revision),metadata:this.metadataValue(updatedTarget.updated,updatedTarget.kind==='folder')});
    }catch(error){next(error)}});
    app.get('/v1/fuse/folder-metadata',async(request:RequestWithIdentity,response,next)=>{try{
      const collectionId=String(request.query.collectionId??'');const path=cleanPath(request.query.path);const target=await this.metadataTarget(request,collectionId,path,'view');
      if(target.kind!=='folder') throw new HttpError(400,'path is not a folder'); const prefix=path?`${path}/`:'';
      const rows=await this.metadata.childFileMetadata(collectionId,prefix);
      const files:Record<string,Record<string,unknown>>={}; for(const row of rows) files[row.path.slice(prefix.length)]=row.metadata;
      response.json({folder:this.metadataValue(target.row,true),files,revision:Math.max(Number(target.row.metadata_revision),...rows.map(row=>Number(row.metadata_revision)))});
    }catch(error){next(error)}});
  }

  private metadataValue(row:any,folder:boolean):Record<string,unknown> {
    const value={...(row.metadata??{})};
    if(folder&&row.description!==null) value.description=row.description;
    if(folder&&row.naming_hint!==null) value.naming_hint=row.naming_hint;
    return value;
  }
  private async metadataTarget(request:RequestWithIdentity,collectionId:string,path:string,right:Right,queryable:pg.Pool|pg.PoolClient=this.db) {
    const file=await this.metadata.liveFileAt(queryable,collectionId,path);
    if(file){await this.access.requireFile(request,file.id,right,queryable);return {kind:'file' as const,row:file}}
    const folder=await this.metadata.liveFolderAt(queryable,collectionId,path);
    if(!folder) throw new HttpError(404,'Files path not found');
    await this.access.requirePath(request,collectionId,path,right,queryable); return {kind:'folder' as const,row:folder};
  }
  private canWriteMetadata(actor:FilesIdentity,key:string):boolean { return !(actor.agentId&&key.startsWith('approved')) }
}
