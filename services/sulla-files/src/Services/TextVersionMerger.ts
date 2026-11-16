// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as Automerge from '@automerge/automerge';
import type pg from 'pg';

import { editTextDocument, newTextDocument, utf8Text, versionCheckedTextSave, type TextDocument } from '../automergeText.js';
import { HttpError } from '../Http/HttpError.js';
import type { LocalManagerGate } from '../Http/LocalManagerGate.js';
import type { LiveTextSessions } from '../liveText.js';
import type { AutomergeDocumentRepository } from '../Repositories/AutomergeDocumentRepository.js';
import type { AutomergeTextStore } from './AutomergeTextStore.js';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
export type StoredVersionReader = (fileId:string, versionId:string) => Promise<Buffer>;
export interface MergedText { bytes:Buffer; document?:Automerge.Doc<TextDocument>; merged:boolean }

/**
 * Plans a version-checked text save (moved from app.ts textSave): merges a submission made against
 * an older base into the current text through Automerge, and into an active live document.
 * Runs outside any transaction; the caller stages the result and commits it under the path lock.
 */
export class TextVersionMerger {
  constructor(
    private readonly documents:AutomergeDocumentRepository,
    private readonly texts:AutomergeTextStore,
    private readonly live:LiveTextSessions,
    private readonly managers:LocalManagerGate,
  ) {}

  readonly merge = async(queryable:Queryable, file:any, baseVersionId:string, submitted:Buffer, currentBytes:Buffer,
    readVersion:StoredVersionReader = (fileId, versionId) => this.managers.fuseExperiment().readStoredVersion(fileId, versionId)):Promise<MergedText> => {
    const baseBytes=baseVersionId===file.current_version_id?currentBytes:await readVersion(file.id,baseVersionId);
    const baseText=utf8Text(baseBytes),currentText=utf8Text(currentBytes),submittedText=utf8Text(submitted);
    if(this.live.has(file.id)&&(submittedText===undefined||submitted.length>8*1024*1024))throw new HttpError(415,'Cannot replace an active live document with binary or oversized content');
    const stale=baseVersionId!==file.current_version_id;
    const planned=versionCheckedTextSave({baseVersionId,currentVersionId:file.current_version_id,base:baseBytes,current:currentBytes,submitted});
    if(planned.status===409)throw new HttpError(409,'Files mount version changed');
    if(baseText===undefined||currentText===undefined||submittedText===undefined)return {bytes:submitted,merged:false};
    let document:Automerge.Doc<TextDocument>;
    if(stale){
      const savedBase=await this.documents.versionHeads(queryable,baseVersionId,file.id);
      const savedCurrent=await this.texts.current(queryable,file.id,file.current_version_id);
      let baseDocument:Automerge.Doc<TextDocument>|undefined,currentDocument:Automerge.Doc<TextDocument>|undefined;
      if(savedCurrent){currentDocument=savedCurrent;if(savedBase){try{baseDocument=Automerge.view(currentDocument,Array.isArray(savedBase.heads)?savedBase.heads:JSON.parse(savedBase.heads));}catch{/* A pre-reset head is rebuilt from the plain version below. */}}}
      if(baseDocument&&currentDocument) {
        document=Automerge.merge(Automerge.clone(currentDocument),editTextDocument(Automerge.clone(baseDocument),submittedText));
      } else {
        const baseDocument=newTextDocument(baseText);
        const rebuiltCurrent=editTextDocument(Automerge.clone(baseDocument),currentText);
        document=Automerge.merge(rebuiltCurrent,editTextDocument(Automerge.clone(baseDocument),submittedText));
      }
    } else {
      const saved=await this.texts.current(queryable,file.id,file.current_version_id);
      document=editTextDocument(saved??newTextDocument(currentText),submittedText);
    }
    const active=this.live.document(file.id);
    if(active) document=Automerge.merge(Automerge.clone(active),document);
    return {bytes:Buffer.from(document.text,'utf8'),document,merged:stale};
  };
}
