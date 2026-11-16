// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import express from 'express';

import { auditContext } from '../auditContext.js';
import { verifyFilesIdentity } from '../auth.js';
import type { Config } from '../config.js';
import type { RequestWithIdentity } from './FilesAccessGate.js';
import { FilesRequestInput } from './FilesRequestInput.js';

/**
 * The request middleware every Files route sits behind. The composition root mounts the
 * stages in this order, around the bootstrap and lock routes: body parsing, authentication,
 * the FUSE actor header, then (after /v1/local/lock) the ready gate and the audit context.
 */
export class FilesRequestPipeline {
  /** Streaming bodies the JSON parser must never buffer. */
  private static readonly rawBodyPaths = ['/v1/files/import', '/v1/local/native-sources/ingest', '/v1/local/system-areas/ingest'];
  private readonly jsonParser = express.json({ limit: '20mb' });

  constructor(private readonly config:Config, private readonly ready:() => boolean) {}

  /** JSON bodies up to 20 MB, except the streamed upload routes. */
  readonly json:express.RequestHandler = (request, response, next) => FilesRequestPipeline.rawBodyPaths.includes(request.path) ||
    /^\/v1\/fuse\/files\/[0-9a-f-]+\/content\/stream$/i.test(request.path) ? next() : this.jsonParser(request, response, next);

  /** /healthz is open; audit events and /v1/local/* need the local service token; everything else a Files identity. */
  readonly authenticate = (request:RequestWithIdentity, response:express.Response, next:express.NextFunction) => {
    const config = this.config;
    if (request.path === '/healthz') return next();
    if (request.path === '/v1/system/audit-events') {
      if (!config.localToken || request.header('x-sulla-files-token') !== config.localToken) return response.status(401).json({error:'unauthorized service request'});
      return next();
    }
    if (request.path.startsWith('/v1/local/')) { if (!config.localToken || request.header('x-sulla-files-token') !== config.localToken) return response.status(401).json({ error: 'unauthorized local request' }); return next() }
    const token = FilesRequestInput.bearer(request);
    try { request.filesIdentity = verifyFilesIdentity(token, config.capabilitySigningKey) } catch {
      response.status(401).json({ error: 'unauthorized' });
    }
    if (request.filesIdentity) next();
  };

  /** X-Sulla-Actor (<agentId>:<jobId>) attributes FUSE requests to an agent run; only the FUSE capability may send it. */
  readonly fuseActor = (request:RequestWithIdentity, response:express.Response, next:express.NextFunction) => {
    const value=request.header('x-sulla-actor');
    if (!value || !request.path.startsWith('/v1/fuse/')) return next();
    const match=/^([A-Za-z0-9._-]{1,128}):([A-Za-z0-9._:-]{1,256})$/.exec(value);
    if (!match) return response.status(400).json({error:'X-Sulla-Actor must be <agentId>:<jobId>'});
    if (request.filesIdentity?.kind!=='capability') return response.status(403).json({error:'X-Sulla-Actor requires the FUSE capability token'});
    request.filesIdentity={...request.filesIdentity,agentId:match[1],jobId:match[2]};
    next();
  };

  /** Nothing but health and audit delivery answers before secure bootstrap unlocks Files. */
  readonly readyGate:express.RequestHandler = (request, response, next) => {
    if (!['/healthz','/v1/system/audit-events'].includes(request.path) && !this.ready()) return response.status(503).json({ code: 'FILES_LOCKED', error: 'Files is locked; secure bootstrap is required' });
    next();
  };

  /** Runs the rest of the request inside its audit context (actor, request id, copy/restore action). */
  readonly audit = (request:RequestWithIdentity, _response:express.Response, next:express.NextFunction) => {
    const actor=request.filesIdentity;
    auditContext.run({actor:actor?.agentId ?? actor?.jobId ?? (actor ? 'human' : 'sulla-files'),
      requestId:request.header('x-request-id')?.slice(0,256) ?? randomUUID(),
      action:request.body?.action === 'copy' || (Array.isArray(request.body?.items) && request.body.items.some((item:any)=>item?.action==='copy')) ? 'copy' : /\/restore$/.test(request.path) ? 'restore' : undefined},next);
  };
}
