// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { FilesCloudEscrowService } from '../filesCloudEscrow.js';

/**
 * Memory-key wrap and Files Cloud escrow routes. Handlers moved verbatim from
 * the former registerFilesCloudEscrowRoute function (E9).
 */
export class FilesCloudEscrowRoutes {
  constructor(
    private readonly service:FilesCloudEscrowService,
    private readonly requireDesktopIdentity:(request:express.Request)=>void,
    private readonly requireHumanSession?:(request:express.Request)=>void,
  ) {}

  register(app:express.Express):void {
    const service=this.service, requireDesktopIdentity=this.requireDesktopIdentity, requireHumanSession=this.requireHumanSession;
    app.post('/v1/memory-sync/wrap-key',async(request,response)=>{try{requireDesktopIdentity(request);response.setHeader('Cache-Control','no-store');response.json(await service.wrapMemoryKey(request.body?.memoryKey))}catch(error){const e=error as {status?:number;code?:string;message?:string};response.status(e.status??500).json({error:e.code??'memory_key_wrap_failed',message:e.message})}});
    app.post('/v1/memory-sync/unwrap-key',async(request,response)=>{try{requireDesktopIdentity(request);response.setHeader('Cache-Control','no-store');response.json(await service.unwrapMemoryKey(request.body?.wrappedKey))}catch(error){const e=error as {status?:number;code?:string;message?:string};response.status(e.status??500).json({error:e.code??'memory_key_unwrap_failed',message:e.message})}});
    app.post('/v1/files/cloud-escrow/key',async(request,response)=>{try{requireDesktopIdentity(request);response.setHeader('Cache-Control','no-store');response.json(await service.key(request.body?.requestId,request.body?.recipientPublicKey))}catch(error){const e=error as {status?:number;code?:string;message?:string};response.status(e.status??500).json({error:e.code??'files_cloud_escrow_failed',message:e.message})}});
    app.post('/v1/files/cloud-escrow/restore-key',async(request,response)=>{try{requireDesktopIdentity(request);response.setHeader('Cache-Control','no-store');response.json(await service.restoreKey(request.body?.requestId,request.body?.recipientPublicKey))}catch(error){const e=error as {status?:number;code?:string;message?:string};response.status(e.status??500).json({error:e.code??'files_cloud_restore_failed',message:e.message})}});
    app.post('/v1/human/files/cloud-escrow/unlock',async(request,response)=>{try{requireHumanSession?.(request);response.setHeader('Cache-Control','no-store');response.json(await service.unlockCloud(request.body?.password))}catch(error){const e=error as {status?:number;code?:string;message?:string};response.status(e.status??500).json({error:e.code??'files_cloud_restore_failed',message:e.message})}});
  }
}
