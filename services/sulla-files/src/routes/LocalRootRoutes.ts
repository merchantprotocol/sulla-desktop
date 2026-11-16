// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { LocalFilesManager } from '../localManager.js';

/** Watched-folder roots and their scan/sync controls. Every route answers 409 when the watched folder is disabled. */
export class LocalRootRoutes {
  constructor(private readonly manager?:LocalFilesManager) {}

  register(app:express.Express):void {
    const manager = this.manager;
    app.get('/v1/local/roots', async(_request, response, next) => { try { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); response.json(await manager.listRoots()) } catch (error) { next(error) } });
    app.post('/v1/local/roots', async(request,response,next)=>{try{if(!manager)return response.status(409).json({error:'watched folder disabled'});response.status(201).json(await manager.attachBrokeredRoot(request.body))}catch(error){next(error)}});
    app.post('/v1/local/roots/:id/scan-state',async(request,response,next)=>{try{if(!manager)return response.status(409).json({error:'watched folder disabled'});response.json(await manager.brokeredScanState(String(request.params.id),request.body))}catch(error){next(error)}});
    app.patch('/v1/local/roots/:id', async(request, response, next) => { try {
      if (!manager) return response.status(409).json({ error: 'watched folder disabled' });
      const exclusions = request.body.exclusions;
      if (exclusions !== undefined && (!Array.isArray(exclusions) || exclusions.length > 200 || exclusions.some((item:unknown) => typeof item !== 'string' || item.length > 500 || item.includes('\0')))) {
        return response.status(400).json({ error: 'exclusions must be an array of safe patterns' });
      }
      if (request.body.syncMode !== undefined && !['local', 'server'].includes(request.body.syncMode)) return response.status(400).json({ error: 'syncMode must be local or server' });
      response.json(await manager.configureRoot(String(request.params.id), {
        paused: request.body.paused === undefined ? undefined : Boolean(request.body.paused),
        syncMode: request.body.syncMode,
        exclusions,
      }));
    } catch (error) { next(error) } });
    app.delete('/v1/local/roots/:id', async(request, response, next) => { try {
      if (!manager) return response.status(409).json({ error: 'watched folder disabled' });
      await manager.detachRoot(String(request.params.id));
      response.status(204).end();
    } catch (error) { next(error) } });
    app.get('/v1/local/recent', async(request, response, next) => { try { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); response.json(await manager.recent(Number(request.query.limit ?? 4), typeof request.query.path === 'string' ? request.query.path : undefined)) } catch (error) { next(error) } });
    app.post('/v1/local/rescan', (_request, response) => { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); manager.rescan().catch(error => console.error('[SullaFiles] rescan failed', error)); response.status(202).json({ accepted: true }) });
    app.post('/v1/local/pause', async(request, response, next) => { try { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); response.json(await manager.setPaused(Boolean(request.body.paused))) } catch (error) { next(error) } });
    app.post('/v1/local/sync', (_request, response) => { if (!manager) return response.status(409).json({ error: 'watched folder disabled' }); manager.sync().catch(error => console.error('[SullaFiles] sync failed', error)); response.status(202).json({ accepted: true }) });
  }
}
