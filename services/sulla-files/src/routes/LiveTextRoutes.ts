// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as Automerge from '@automerge/automerge';
import type express from 'express';

import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { HttpError } from '../Http/HttpError.js';
import type { LiveTextCoordinator } from '../Services/LiveTextCoordinator.js';

/** Live text editing: open a session, exchange Automerge sync messages, stream events, leave (moved from app.ts). */
export class LiveTextRoutes {
  constructor(private readonly access:FilesAccessGate, private readonly live:LiveTextCoordinator) {}

  register(app:express.Express):void {
    const live = this.live.sessions; const liveBase = (id:string) => `/v1/files/${id}/live`;
    app.post('/v1/files/:id/live',async(request:RequestWithIdentity,response,next)=>{try{
      // Load and build the document first; the transaction only re-checks the version and saves it.
      const file=await this.access.requireFile(request,request.params.id,'view');
      await this.access.visibleVersion(request,file,file.current_version_id);
      let editable=true;try{await this.access.requireFile(request,file.id,'edit')}catch(error){if((error as HttpError).status!==403)throw error;editable=false;}
      const actor=this.access.identity(request);
      if(editable)this.live.authorize(file.id,request);
      if(!live.has(file.id)) await this.live.open(request,file);
      const peer=live.join(file.id,{owner:this.live.owner(request),editable,name:actor.agentId??actor.jobId??actor.userId,kind:actor.agentId||actor.jobId?'agent':'user'});
      response.json({...peer,versionId:file.current_version_id,events:`${liveBase(file.id)}/${peer.peerId}/events`});
    }catch(error){next(error)}});
    app.post('/v1/files/:id/live/:peerId/sync',async(request:RequestWithIdentity,response,next)=>{try{await this.live.peer(request);const p=live.peer(request.params.id,request.params.peerId);const message=request.body?.message;if(typeof message!=='string'||message.length>12*1024*1024)throw new HttpError(400,'Invalid sync message');
      // Live versions are attributed to the last peer that actually sent changes, not the last one to sync.
      if(p.editable&&Automerge.decodeSyncMessage(Buffer.from(message,'base64')).changes.length){await this.access.requireFile(request,request.params.id,'edit');this.live.authorize(request.params.id,request);}response.json({message:live.receive(request.params.id,request.params.peerId,Buffer.from(message,'base64'),p.editable)});}catch(error){next(error)}});
    app.get('/v1/files/:id/live/:peerId/events',async(request:RequestWithIdentity,response,next)=>{try{await this.live.peer(request);response.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});response.flushHeaders();
      let delivery=Promise.resolve();
      const unsubscribe=live.subscribe(request.params.id,request.params.peerId,event=>{delivery=delivery.then(async()=>{await this.live.peer(request);response.write(`data: ${JSON.stringify(event)}\n\n`);}).catch(()=>{response.end();});});
      const heartbeat=setInterval(()=>{void this.live.peer(request).then(()=>response.write(': heartbeat\n\n')).catch(()=>response.end());},20_000);heartbeat.unref();
      request.on('close',()=>{clearInterval(heartbeat);unsubscribe();void live.leave(request.params.id,request.params.peerId).catch(()=>{});});
    }catch(error){next(error)}});
    app.delete('/v1/files/:id/live/:peerId',async(request:RequestWithIdentity,response,next)=>{try{await this.live.peer(request);await live.leave(request.params.id,request.params.peerId);response.sendStatus(204);}catch(error){next(error)}});
  }
}
