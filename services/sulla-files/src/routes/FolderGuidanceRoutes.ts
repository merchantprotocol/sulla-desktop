// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import { ListingPage } from '../ListingPage.js';
import type { CollectionSettingsRepository } from '../Repositories/CollectionSettingsRepository.js';
import type { FolderGuidanceRepository } from '../Repositories/FolderGuidanceRepository.js';
import { ensureStoredFolder, lockStoredNamespace, storedParentPaths } from '../storedNamespace.js';
import { LikePattern } from '../LikePattern.js';

type FolderDetails = { folderId:string; path:string; revision:string; description:string | null; namingHint:string | null; needsDescription:boolean };

/** Folder listing, creation and the description / naming guidance on folders and collections. */
export class FolderGuidanceRoutes {
  constructor(
    private readonly access:FilesAccessGate,
    private readonly folders:FolderGuidanceRepository,
    private readonly collections:CollectionSettingsRepository,
    private readonly transactions:TransactionRunner,
    private readonly audit:RequestAuditLog,
  ) {}

  register(app:express.Express):void {
    const { requireCollection, requirePath } = this.access; const audit = this.audit.record; const { folderGuidance } = FilesRequestInput;
    app.get('/v1/folders', async(request:RequestWithIdentity, response, next) => { try { await this.list(request, response) } catch (error) { next(error) } });
    app.get('/v1/folders/map', async(request:RequestWithIdentity,response,next)=>{ try {
      const limit=Math.min(40,Math.max(1,Number(request.query.limit??40)||40));
      const roots=await this.folders.describedRoots(limit);
      const folders=await this.folders.describedFolders(limit);
      response.json([...roots,...folders].slice(0,limit).map(row=>({collectionId:row.collection_id,path:row.path,collectionName:row.name,description:row.description,namingHint:row.naming_hint,needsDescription:String(row.description).endsWith('— needs description')})));
    } catch(error){next(error)} });
    app.get('/v1/folders/where', async(request:RequestWithIdentity,response,next)=>{ try { await this.where(request, response) } catch(error){next(error)} });
    app.patch('/v1/folders/:id/description', async(request:RequestWithIdentity,response,next)=>{ try {
      const current=await this.folders.liveFolder(request.params.id); if(!current) throw new HttpError(404,'folder not found');
      await requirePath(request,current.collection_id,current.path,'edit'); const description=folderGuidance(request.body.description,'description'); const namingHint=folderGuidance(request.body.namingHint,'namingHint');
      const updated=await this.folders.describeFolder(current.id,description,namingHint);
      await audit(request,'change-folder-description',undefined,{collectionId:current.collection_id,folderPath:current.path,description,namingHint}); response.json({...updated,needsDescription:false});
    } catch(error){next(error)} });
    app.patch('/v1/collections/:id/description', async(request:RequestWithIdentity,response,next)=>{ try {
      await requireCollection(request,request.params.id,'manage'); const description=folderGuidance(request.body.description,'description'); const namingHint=folderGuidance(request.body.namingHint,'namingHint');
      const updated=await this.collections.describe(request.params.id,description,namingHint);
      await audit(request,'change-collection-description',undefined,{collectionId:request.params.id,description,namingHint}); response.json(updated);
    } catch(error){next(error)} });
    app.patch('/v1/collections/:id/cloud-sync', async(request:RequestWithIdentity,response,next)=>{ try {
      await requireCollection(request,request.params.id,'manage');
      const enabled=request.body.enabled===true;
      const updated=await this.collections.setCloudCatalogSync(request.params.id,enabled);
      await audit(request,'change-collection-cloud-sync',undefined,{collectionId:request.params.id,enabled});
      app.locals.catalogSync?.syncNow().catch(()=>undefined);
      response.json(updated);
    } catch(error){next(error)} });
    app.patch('/v1/collections/:id/keep-on-computer', async(request:RequestWithIdentity,response,next)=>{ try {
      await requireCollection(request,request.params.id,'manage');
      if(typeof request.body?.enabled!=='boolean') throw new HttpError(400,'enabled must be a boolean');
      const enabled=request.body.enabled;
      const updated=await this.collections.setKeepOnComputer(request.params.id,enabled);
      await audit(request,'change-collection-keep-on-computer',undefined,{collectionId:request.params.id,enabled});
      response.json(updated);
    } catch(error){next(error)} });
    app.post('/v1/folders', async(request:RequestWithIdentity, response, next) => { try { await this.create(request, response) } catch (error) { next(error) } });
  }

  private async list(request:RequestWithIdentity, response:express.Response):Promise<void> {
    const collectionId = String(request.query.collectionId ?? '');
    if (!collectionId) throw new HttpError(400, 'collectionId is required');
    await this.access.requireCollection(request, collectionId, 'view', true, true);
    const paged=ListingPage.isRequested(request.query.limit,request.query.cursor);
    let pageRequest:ListingPage; try { pageRequest=ListingPage.parse(request.query.limit,request.query.cursor); } catch { throw new HttpError(400,'invalid listing cursor'); }
    const rows = await this.folders.page(collectionId,pageRequest.after,paged?pageRequest.limit+1:ListingPage.legacyMaxRows+1);
    if(!paged && rows.length>ListingPage.legacyMaxRows) throw new HttpError(413,'folder listing exceeds the 20,000-row compatibility limit; use limit and cursor pagination');
    const hasMore=paged && rows.length>pageRequest.limit; const page=rows.slice(0,paged?pageRequest.limit:ListingPage.legacyMaxRows); if(paged) pageRequest.apply(response,hasMore,page.at(-1)?.path);
    const visible:(string|FolderDetails)[] = [];
    for (const row of page) {
      try { await this.access.requirePath(request, collectionId, row.path, 'view'); visible.push(request.query.details==='true'?{folderId:row.id,path:row.path,revision:row.revision,description:row.description,namingHint:row.naming_hint,needsDescription:row.needs_description}:row.path) }
      catch (error:any) { if (error.status !== 403) throw error }
    }
    response.json(visible);
  }

  private async where(request:RequestWithIdentity, response:express.Response):Promise<void> {
    const what=String(request.query.what??'').trim(); if(!what) throw new HttpError(400,'what is required');
    const kind=String(request.query.kind??''); const project=String(request.query.project??'');
    const tokens=[what,kind,project].join(' ').toLowerCase().split(/[^a-z0-9]+/).filter(token=>token.length>1);
    const roots=await this.folders.rootCandidates();
    // Only folders matching at least one token are ranked, capped; ranking needs candidates, not every folder.
    const patterns=tokens.map(token=>LikePattern.contains(token));
    const folders=await this.folders.folderCandidates(patterns);
    const ranked=[...roots,...folders].map(row=>{const haystack=`${row.name} ${row.path} ${row.description} ${row.naming_hint??''}`.toLowerCase();return{collectionId:row.collection_id,path:row.path,collectionName:row.name,description:row.description,namingHint:row.naming_hint,needsDescription:String(row.description).endsWith('— needs description'),score:tokens.reduce((score,token)=>score+(haystack.includes(token)?1:0),0)}}).sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path)).slice(0,10);
    const suggested=ranked[0]??null; const filename=FilesRequestInput.suggestedFileName(what,kind);
    response.json({matches:ranked,suggestedFolder:suggested,suggestedFilename:filename,suggestedPath:suggested?[suggested.path,filename].filter(Boolean).join('/'):filename});
  }

  private async create(request:RequestWithIdentity, response:express.Response):Promise<void> {
    const { folderGuidance } = FilesRequestInput;
    const collectionId = String(request.body.collectionId ?? '');
    const folderPath = FilesRequestInput.cleanPath(request.body.path, false);
    await this.access.requirePath(request, collectionId, folderPath, 'edit');
    const actor = this.access.identity(request); const agentCreated=Boolean(actor.agentId||actor.jobId);
    const description=folderGuidance(request.body.description,'description',agentCreated); const namingHint=folderGuidance(request.body.namingHint,'namingHint');
    await this.transactions.run('create-folder',async client=>{
      await this.access.requirePath(request,collectionId,folderPath,'edit',client);
      await lockStoredNamespace(client, collectionId);
      await ensureStoredFolder(client, collectionId, folderPath, actor);
      if (description) await this.folders.describeFolderAt(client,collectionId,folderPath,description,namingHint);
      if (agentCreated) { const fallback=`Created by ${actor.agentId??actor.jobId} on ${new Date().toISOString().slice(0,10)} — needs description`; await this.folders.markUndescribed(client,collectionId,storedParentPaths(folderPath),fallback); }
    });
    await this.audit.record(request,'create-folder',undefined,{collectionId,folderPath,description,namingHint});
    response.status(201).json({ collectionId, path: folderPath, description, namingHint, needsDescription:false });
  }
}
