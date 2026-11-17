// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type { FilesIdentity } from '../auth.js';
import type { Config } from '../config.js';
import { OrgCollectionEnrollment, type OrgCollectionLevel } from '../Services/OrgCollectionEnrollment.js';
import type { CloudSyncService } from '../cloudSync/service.js';
import { ProfileIdentity } from '../ProfileIdentity.js';

/** Desktop-control-only enrollment API; agent and job capabilities are explicitly refused. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export class OrgCollectionRoutes {
  constructor(private readonly config:Pick<Config,'mode'>,private readonly enrollment:OrgCollectionEnrollment,private readonly cloudSync?:CloudSyncService,
    private readonly profileCaches?:{ invalidateProfile(profileId:string):void }) {}
  register(app:express.Express):void {
    const route=(handler:(request:express.Request & {filesIdentity?:FilesIdentity},response:express.Response)=>Promise<void>)=>async(request:express.Request & {filesIdentity?:FilesIdentity},response:express.Response)=>{
      try { const identity=request.filesIdentity;
        if(this.config.mode!=='desktop'||identity?.kind!=='capability'||identity.agentId||identity.jobId) throw Object.assign(new Error('desktop control capability required'),{status:403});
        response.setHeader('Cache-Control','no-store'); await handler(request,response);
      } catch(error) { const status=Number((error as any)?.status); const publicStatus=status===503?503:Number.isInteger(status)&&status>=400&&status<500?status:500; response.status(publicStatus).json({error:publicStatus!==500?(error as Error).message:'organization collection request failed'}); }
    };
    app.get('/v1/desktop/org-collections',route(async(_request,response)=>{response.json(await this.enrollment.list())}));
    app.post('/v1/desktop/org-collections/root-transport',route(async(_request,response)=>{
      if(!this.cloudSync) throw Object.assign(new Error('organization sync is not configured'),{status:503});
      response.json(await this.cloudSync.requestOrgRootTransport());
    }));
    app.put('/v1/desktop/org-collections/:id/root',route(async(request,response)=>{
      if(!this.cloudSync) throw Object.assign(new Error('organization sync is not configured'),{status:503});
      const body=request.body;
      await this.cloudSync.installOrgRoot({collectionId:String(request.params.id),requestId:String(body?.requestId??''),keyVersion:Number(body?.keyVersion),transport:body?.transport});
      response.sendStatus(204);
    }));
    app.post('/v1/desktop/org-collections/:id/sync',route(async(request,response)=>{
      if(!this.cloudSync) throw Object.assign(new Error('organization sync is not configured'),{status:503});
      response.json(await this.cloudSync.enableOrgSync(String(request.params.id),Number(request.body?.keyVersion),request.body?.head));
    }));
    app.put('/v1/desktop/org-collections/:id',route(async(request,response)=>{
      const body=request.body;
      const result=await this.enrollment.enroll({collectionId:String(request.params.id),orgId:String(body.orgId??''),orgName:String(body.orgName??''),name:String(body.name??''),creatorUserId:String(body.creatorUserId??''),level:body.level as OrgCollectionLevel});
      response.json(result);
    }));
    app.patch('/v1/desktop/org-collections/:id/level',route(async(request,response)=>{
      const result=await this.enrollment.updateLevel(String(request.params.id),request.body?.level as OrgCollectionLevel);
      if(!result){ response.sendStatus(404); return; }
      response.json(result);
    }));
    // Desktop sign-out/lock drops that Cloud profile's keys here. Desktop-control capability plus loopback only.
    app.post('/v1/desktop/org-profiles/:profileId/invalidate',route(async(request,response)=>{
      if(!this.profileCaches) throw Object.assign(new Error('profile key caches are not configured'),{status:503});
      if(!LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? '')) throw Object.assign(new Error('loopback required'),{status:403});
      const profileId=String(request.params.profileId);
      if(!ProfileIdentity.isProfileId(profileId)) throw Object.assign(new Error('invalid profile id'),{status:400});
      this.profileCaches.invalidateProfile(profileId);
      response.sendStatus(204);
    }));
    app.delete('/v1/desktop/org-collections/:id',route(async(request,response)=>{
      if(!await this.enrollment.unenroll(String(request.params.id))){ response.sendStatus(404); return; }
      this.cloudSync?.clearOrgRootKeys(String(request.params.id)); response.sendStatus(204);
    }));
  }
}
