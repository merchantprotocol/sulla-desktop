// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as Automerge from '@automerge/automerge';
import type pg from 'pg';

import { loadTextDocument, newTextDocument, saveTextDocument, textDocumentHeads, utf8Text, type TextDocument } from '../automergeText.js';
import type { Config } from '../config.js';
import type { TransactionRunner } from '../FilesTransaction.js';
import type { FilesAccessGate, RequestWithIdentity, Right } from '../Http/FilesAccessGate.js';
import { HttpError } from '../Http/HttpError.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import { LiveTextSessions } from '../liveText.js';
import { loadFileContent } from '../preview.js';
import type { AutomergeDocumentRepository } from '../Repositories/AutomergeDocumentRepository.js';
import type { Store } from '../store.js';
import { lockStoredNamespace } from '../storedNamespace.js';
import type { AutomergeTextStore } from './AutomergeTextStore.js';
import type { VersionWriter } from './VersionWriter.js';

/**
 * Live text sessions and their authorized writers (moved from app.ts). A session's document is
 * persisted by flush(): merging, reading and encrypting run outside any transaction, which only
 * re-checks the version and the stored document under the path lock and records the result.
 */
export class LiveTextCoordinator {
  private readonly writers = new Map<string, RequestWithIdentity>();
  readonly sessions = new LiveTextSessions(2_000, id => this.writers.delete(id));

  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly access:FilesAccessGate,
    private readonly transactions:TransactionRunner,
    private readonly versions:VersionWriter,
    private readonly documents:AutomergeDocumentRepository,
    private readonly texts:AutomergeTextStore,
    private readonly audit:RequestAuditLog,
  ) {}

  /** The writer whose rights a later flush re-checks. */
  authorize(fileId:string, request:RequestWithIdentity):void { this.writers.set(fileId, request) }

  /** Hands a saved document to an active live session, attributing it to this writer. */
  readonly adopt = (request:RequestWithIdentity, fileId:string, document:Automerge.Doc<TextDocument>):void => {
    if(!this.sessions.has(fileId))return;this.writers.set(fileId,request);const actor=this.access.identity(request);
    this.sessions.adopt(fileId,document,{name:actor.agentId??actor.jobId??actor.userId,kind:actor.agentId||actor.jobId?'agent':'user'});
  };

  owner(request:RequestWithIdentity):string { const a=this.access.identity(request);return JSON.stringify([a.userId,a.deviceId,a.agentId,a.jobId]) }

  async peer(request:RequestWithIdentity, right:Right = 'view'):Promise<any> {
    const file=await this.access.requireFile(request,request.params.id,right);
    await this.access.visibleVersion(request,file,file.current_version_id);
    this.sessions.peer(file.id,request.params.peerId,this.owner(request));return file;
  }

  /** Opens the session for a file: load and build the document first; the transaction only re-checks the version and saves it. */
  async open(request:RequestWithIdentity, file:any):Promise<void> {
    const loaded=await loadFileContent(this.db,this.config,this.store,file.id,file.current_version_id);const text=loaded&&utf8Text(loaded.buffer);
    if(typeof text!=='string'||loaded!.buffer.length>8*1024*1024)throw new HttpError(415,'Live editing requires UTF-8 text up to 8 MiB');
    const saved=await this.texts.current(this.db,file.id,file.current_version_id);
    const document=saved??newTextDocument(text);
    await this.transactions.run('live-open',async client=>{
      await lockStoredNamespace(client,file.collection_id,file.path);
      const current=await this.access.requireFile(request,file.id,'view',client);
      if(current.current_version_id!==file.current_version_id||current.path!==file.path) throw new HttpError(409,'Files changed concurrently or are busy; retry');
      await this.texts.save(client,file.id,file.current_version_id,document);
    });
    // Reauthorize on each durable write; revoked rights and protected paths fail closed.
    if(!this.sessions.has(file.id)) this.sessions.open(file.id,document,snapshot=>this.flush(file.id,snapshot));
  }

  /** Persists a live document. A concurrent writer in between makes the snapshot stale: redo (bounded). */
  async flush(fileId:string, snapshot:Automerge.Doc<TextDocument>):Promise<void> {
    const request=this.writers.get(fileId);if(!request)throw new HttpError(403,'No authorized live writer');const actor=this.access.identity(request);
    for(let attempt=1;;attempt++){
      const current=await this.access.requireFile(request,fileId,'edit');
      const latest=await this.documents.latest(fileId);
      if(latest)snapshot=Automerge.merge(snapshot,loadTextDocument(latest.document));
      const bytes=Buffer.from(snapshot.text);const existing=await loadFileContent(this.db,this.config,this.store,fileId,current.current_version_id);
      const changed=!existing?.buffer.equals(bytes);
      const staged=changed?await this.versions.stage(current.collection_id,bytes):undefined;
      const outcome=await this.transactions.run('live-flush',async tx=>{
        await lockStoredNamespace(tx,current.collection_id,current.path);
        const locked=await this.access.requireFile(request,fileId,'edit',tx);
        const stamp=await this.documents.stamp(tx,fileId);
        if(locked.current_version_id!==current.current_version_id||locked.path!==current.path||stamp!==latest?.stamp) return undefined;
        if(!changed){await this.documents.replaceDocument(tx,fileId,saveTextDocument(snapshot),JSON.stringify(textDocumentHeads(snapshot)));return {};}
        const result=await this.versions.insert(tx,{collectionId:current.collection_id,fileId:current.id,path:current.path,mime:current.mime,bytes,staged:staged!,actor,message:'Live document edit',baseVersionId:current.current_version_id});
        await this.texts.save(tx,current.id,result.current_version_id,snapshot);
        await this.audit.record(request,'live-edit',result,{versionId:result.current_version_id},tx);
        return {result};
      });
      if(outcome)return;
      if(attempt>=4)throw new HttpError(409,'Files changed concurrently or are busy; retry');
    }
  }
}
