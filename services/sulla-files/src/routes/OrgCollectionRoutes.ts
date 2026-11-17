// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type { FilesIdentity } from '../auth.js';
import type { Config } from '../config.js';
import { OrgCollectionEnrollment, type OrgCollectionLevel } from '../Services/OrgCollectionEnrollment.js';

/** Desktop-control-only enrollment API; agent and job capabilities are explicitly refused. */
export class OrgCollectionRoutes {
  constructor(private readonly config:Pick<Config,'mode'>,private readonly enrollment:OrgCollectionEnrollment) {}
  register(app:express.Express):void {
    const route=(handler:(request:express.Request & {filesIdentity?:FilesIdentity},response:express.Response)=>Promise<void>)=>async(request:express.Request & {filesIdentity?:FilesIdentity},response:express.Response)=>{
      try { const identity=request.filesIdentity;
        if(this.config.mode!=='desktop'||identity?.kind!=='capability'||identity.agentId||identity.jobId) throw Object.assign(new Error('desktop control capability required'),{status:403});
        response.setHeader('Cache-Control','no-store'); await handler(request,response);
      } catch(error) { const status=Number((error as any)?.status); response.status(Number.isInteger(status)&&status>=400&&status<500?status:500).json({error:status>=400&&status<500?(error as Error).message:'organization collection request failed'}); }
    };
    app.get('/v1/desktop/org-collections',route(async(_request,response)=>{response.json(await this.enrollment.list())}));
    app.put('/v1/desktop/org-collections/:id',route(async(request,response)=>{
      const body=request.body;
      const result=await this.enrollment.enroll({collectionId:String(request.params.id),orgId:String(body.orgId??''),orgName:String(body.orgName??''),name:String(body.name??''),creatorUserId:String(body.creatorUserId??''),level:body.level as OrgCollectionLevel});
      response.json(result);
    }));
    app.patch('/v1/desktop/org-collections/:id/level',route(async(request,response)=>{
      const result=await this.enrollment.updateLevel(String(request.params.id),request.body?.level as OrgCollectionLevel);
      if(!result) return response.sendStatus(404); response.json(result);
    }));
    app.delete('/v1/desktop/org-collections/:id',route(async(request,response)=>{
      if(!await this.enrollment.unenroll(String(request.params.id))) return response.sendStatus(404); response.sendStatus(204);
    }));
  }
}
