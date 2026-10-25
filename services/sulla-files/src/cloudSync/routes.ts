import type express from 'express';

import type { FilesIdentity } from '../auth.js';
import type { Config } from '../config.js';
import type { CloudSyncService } from './service.js';

type RequestWithIdentity = express.Request & { filesIdentity?:FilesIdentity };
type Handler = (service:CloudSyncService, request:RequestWithIdentity, response:express.Response) => Promise<void>;

class RouteError extends Error {
  constructor(readonly status:number, message:string) { super(message) }
}

/**
 * Only main's own desktop capability may drive cloud sync: a capability token
 * that carries an agent or job identity is an agent, and is refused.
 */
function requireDesktopControl(config:Pick<Config, 'mode'>, request:RequestWithIdentity):void {
  const identity = request.filesIdentity;
  if (config.mode !== 'desktop' || identity?.kind !== 'capability' || identity.agentId || identity.jobId) {
    throw new RouteError(403, 'desktop control capability required');
  }
}

/** Known errors keep their status and short message; anything else becomes a generic 500 so no content leaks. */
function publicError(error:any):{ status:number; body:Record<string, string> } {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status < 500) return { status, body: { error: String(error.message ?? 'request failed').slice(0, 200) } };
  if (error?.code === 'FILE_OFFLINE') return { status: 503, body: { error: 'Sulla Cloud is unreachable', code: 'FILE_OFFLINE' } };
  if (status === 503) return { status, body: { error: 'cloud sync is not configured' } };
  return { status: 500, body: { error: 'cloud sync request failed' } };
}

export function registerCloudSyncRoutes(app:express.Express, config:Pick<Config, 'mode'>, cloudSync:CloudSyncService | undefined):void {
  const route = (handler:Handler) => async(request:RequestWithIdentity, response:express.Response) => {
    try {
      requireDesktopControl(config, request);
      if (!cloudSync) throw new RouteError(503, 'cloud sync is not configured');
      response.setHeader('Cache-Control', 'no-store');
      await handler(cloudSync, request, response);
    } catch (error) {
      const { status, body } = publicError(error);
      response.status(status).json(body);
    }
  };

  app.get('/v1/desktop/cloud-sync/status', route(async(service, _request, response) => {
    response.json(await service.status());
  }));

  app.get('/v1/desktop/cloud-sync/finder-badges', route(async(service, request, response) => {
    const collectionId = String(request.query.collectionId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(collectionId)) throw new RouteError(400, 'collectionId is required');
    response.json(await service.finderBadges(collectionId));
  }));

  app.post('/v1/desktop/cloud-sync/collections/:collectionId/enable', route(async(service, request, response) => {
    if (typeof request.body?.enabled !== 'boolean') throw new RouteError(400, 'enabled must be boolean');
    response.json(await service.enable(String(request.params.collectionId), request.body.enabled));
  }));

  app.post('/v1/desktop/cloud-sync/collections/:collectionId/delete-cloud-copy', route(async(service, request, response) => {
    response.status(202).json(await service.deleteCloudCopy(String(request.params.collectionId)));
  }));

  app.post('/v1/desktop/cloud-sync/escrow-key/request', route(async(service, _request, response) => {
    response.json(await service.requestEscrowKey());
  }));

  app.post('/v1/desktop/cloud-sync/escrow-key', route(async(service, request, response) => {
    response.status(202).json(await service.acceptEscrowKey(request.body));
  }));

  app.post('/v1/desktop/cloud-sync/prepare', route(async(service, _request, response) => {
    const prepared = await service.prepare();
    if (prepared) response.json(prepared);
    else response.status(204).end();
  }));

  app.post('/v1/desktop/cloud-sync/send', route(async(service, request, response) => {
    response.json(await service.send(request.body));
  }));

  app.get('/v1/desktop/cloud-sync/cloud-collections', route(async(service, _request, response) => {
    response.json(await service.cloudCollections());
  }));

  app.post('/v1/desktop/cloud-sync/restore', route(async(service, request, response) => {
    response.json(await service.restore(request.body));
  }));

  app.post('/v1/desktop/cloud-sync/restore-all', route(async(service, request, response) => {
    response.json(await service.restoreAll(request.body));
  }));
}
