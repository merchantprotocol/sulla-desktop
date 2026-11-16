// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { Config } from '../config.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { HttpError } from '../Http/HttpError.js';
import type { LocalFilesManager } from '../localManager.js';
import { OriginalRevealAttestations, type OriginalRevealTarget } from '../originalReveal.js';

/**
 * /v1/original-reveal: the native main process attests, then redeems, a one-time right to reveal a
 * file's original on disk. Both the native-only local secret and a fresh principal capability are
 * required; the local secret alone must never bypass Files authorization.
 */
export class OriginalRevealRoutes {
  constructor(
    private readonly config:Config,
    private readonly access:FilesAccessGate,
    private readonly manager?:LocalFilesManager,
    private readonly attestations = new OriginalRevealAttestations(),
  ) {}

  register(app:express.Express):void {
    const { requireFile, visibleVersion } = this.access;
    app.post('/v1/original-reveal/attest',async(request:RequestWithIdentity,response,next) => { try {
      const actor = this.requireOriginalMain(request);
      const file = await requireFile(request,String(request.body.fileId ?? ''),'view');
      const versionId = await visibleVersion(request,file,request.body.versionId);
      response.setHeader('Cache-Control','no-store');
      if (file.deleted_at || versionId !== file.current_version_id) return response.json({ status:'unavailable',code:'no-current-original' });
      const target = await this.manager!.originalRevealTarget(file);
      if (!target) return response.json({ status:'unavailable',code:'no-current-original' });
      await this.reauthorize(request,target);
      response.json({ status:'attested',...this.attestations.issue(actor,target),target });
    } catch (error) { next(error) } });
    app.post('/v1/original-reveal/redeem',async(request:RequestWithIdentity,response,next) => { try {
      const actor = this.requireOriginalMain(request);
      const expected = this.attestations.consume(actor,request.body.token);
      const file = await requireFile(request,expected.fileId,'view');
      await visibleVersion(request,file,expected.versionId);
      if (file.deleted_at) throw Object.assign(new HttpError(409,'Original changed'),{ code:'original-changed' });
      const current = await this.manager!.originalRevealTarget(file);
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw Object.assign(new HttpError(409,'Original changed'),{ code:'original-changed' });
      await this.reauthorize(request,current);
      response.setHeader('Cache-Control','no-store');
      response.json({ status:'redeemed',target:current });
    } catch (error) { next(error) } });
  }

  /** Error mapping for /v1/original-reveal; mounted where it always was, after every route. */
  registerErrorHandler(app:express.Express):void {
    app.use('/v1/original-reveal', (error:any,_request:any,response:any,_next:any) => {
      const status=typeof error.status==='number'?error.status:409;
      response.setHeader('Cache-Control','no-store');
      response.status(status).json({ error:!error.status?'Original changed or is unavailable':status>=500?'Original reveal failed':error.message,
        code:error.code ?? (status===403?'original-forbidden':status===401?'unauthorized':status===404?'original-not-found':'original-changed') });
    });
  }

  private requireOriginalMain(request:RequestWithIdentity) {
    if (this.config.mode !== 'desktop' || !this.manager) throw new HttpError(404,'Original reveal is unavailable');
    const actor = this.access.identity(request);
    if (!this.config.localToken || request.header('x-sulla-files-token') !== this.config.localToken ||
      actor.kind !== 'capability' || !actor.deviceId || actor.agentId || actor.jobId || actor.threadId ||
      actor.userId !== this.config.userId) throw new HttpError(403,'Native main identity required');
    return actor;
  }

  private async reauthorize(request:RequestWithIdentity, target:OriginalRevealTarget):Promise<void> {
    const fresh=await this.access.requireFile(request,target.fileId,'view');
    await this.access.visibleVersion(request,fresh,target.versionId);
    if (fresh.deleted_at || fresh.collection_id!==target.collectionId || fresh.path!==target.relativePath ||
      fresh.current_version_id!==target.versionId || String(fresh.operation_revision)!==target.revision) throw Object.assign(new HttpError(409,'Original changed'),{code:'original-changed'});
  }
}
