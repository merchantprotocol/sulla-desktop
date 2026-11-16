// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';
import type pg from 'pg';

import type { Config } from '../config.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { HttpError } from '../Http/HttpError.js';
import type { RequestAuditLog } from '../Http/RequestAuditLog.js';
import { loadFileContent } from '../preview.js';
import { isProtectedPath } from '../protectedFiles.js';
import type { AgentFileRepository } from '../Repositories/AgentFileRepository.js';
import type { Store } from '../store.js';

/**
 * Agent-run file reads: run inventory, the Use Case home collection, reading one agent file,
 * linking files, and ending a run. Agent writes and keeps still live in app.ts.
 */
export class AgentFileRoutes {
  constructor(
    private readonly db:pg.Pool,
    private readonly config:Config,
    private readonly store:Store,
    private readonly access:FilesAccessGate,
    private readonly agentFiles:AgentFileRepository,
    private readonly audit:RequestAuditLog,
  ) {}

  /** POST /v1/agent-files/query, mounted before the agent write route as before. */
  registerQuery(app:express.Express):void {
    app.post('/v1/agent-files/query', async(request:RequestWithIdentity, response, next) => {
      try {
        if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new HttpError(400, 'valid JSON body required');
        const runIds = Array.isArray(request.body.runIds) ? [...new Set(request.body.runIds.filter((value:unknown):value is string => typeof value === 'string' && value.length > 0))].slice(0, 100) as string[] : [];
        if (!runIds.length) return response.json([]);
        const actor = this.access.identity(request); const threadId = typeof request.body.threadId === 'string' ? request.body.threadId : '';
        if (!threadId) throw new HttpError(400, 'threadId is required');
        if (await this.agentFiles.legacyRunFileCount(actor.userId, runIds, actor.orgId ?? null) > 0) throw new HttpError(409, 'Legacy agent files need an explicit secure import from the retired external chunk store; records were preserved and were not opened');
        const rows = await this.agentFiles.runFiles(actor.userId, runIds, threadId, actor.orgId ?? null);
        response.json(rows.filter(row => !isProtectedPath(row.path)));
      } catch (error:any) {
        const databaseCode = typeof error?.code === 'string' && ['22P02', '23503', '23505', '42P01', '42703'].includes(error.code) ? error.code : undefined;

        console.error('[SullaFiles] agent inventory query failed', {
          category:     error instanceof HttpError && error.status < 500 ? 'invalid-request' : 'internal-error',
          status:       error instanceof HttpError ? error.status : 500,
          databaseCode,
        });
        next(error);
      }
    });
  }

  /** The Use Case home collection, agent file read and file edges, mounted after the agent write/ensure routes. */
  register(app:express.Express):void {
    const { identity } = this.access;
    // Agents write Use Case drafts into the home collection; /v1/local/* is desktop-only.
    app.get('/v1/agent-files/use-case-collection', async(request:RequestWithIdentity, response, next) => { try {
      identity(request);
      const collectionId = await this.agentFiles.homeCollectionId(identity(request).userId);
      if (!collectionId) throw new HttpError(404, 'Home collection is not initialized');
      response.json({ collectionId });
    } catch (error) { next(error) } });
    app.get('/v1/agent-files/:id', async(request:RequestWithIdentity, response, next) => { try {
      const file = await this.access.requireFile(request, request.params.id, 'view');
      const versionId = typeof request.query.versionId === 'string' ? request.query.versionId : file.current_version_id;
      const version = await this.agentFiles.liveVersion(versionId, file.id);
      if (!version) throw new HttpError(404, 'file version not found');
      const content = await loadFileContent(this.db, this.config, this.store, file.id, version.id); if (!content) throw new HttpError(404, 'file content not found');
      await this.audit.record(request, 'get', { ...file, current_version_id: version.id });
      response.json({ file, version, content_base64: content.buffer.toString('base64') });
    } catch (error) { next(error) } });
    app.post('/v1/file-edges', async(request:RequestWithIdentity, response, next) => { try {
      const file = await this.access.requireFile(request, String(request.body.fileId ?? ''), 'edit'); const target = await this.access.requireFile(request, String(request.body.targetFileId ?? ''), 'view');
      if (!['links_to', 'derived_from'].includes(request.body.kind)) throw new HttpError(400, 'invalid edge kind');
      await this.agentFiles.link(file.id, target.id, request.body.kind, identity(request).jobId ?? identity(request).userId);
      response.status(204).end();
    } catch (error) { next(error) } });
  }

  /** POST /v1/agent-runs/:runId/end, mounted after the agent-run keep route as before. */
  registerRunEnd(app:express.Express):void {
    app.post('/v1/agent-runs/:runId/end', async(request:RequestWithIdentity, response, next) => { try {
      const actor = this.access.identity(request);
      response.json({ count: await this.agentFiles.expireRunScratch(actor.userId, actor.jobId, actor.orgId ?? null) });
    } catch (error) { next(error) } });
  }
}
