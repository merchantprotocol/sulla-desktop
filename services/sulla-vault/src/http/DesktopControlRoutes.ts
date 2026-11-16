// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { VaultConfig } from '../config.js';
import { isTransientDbError, warnDatabaseUnavailable } from '../db.js';
import type { VaultFilesKeyBundleAuthority } from '../filesKeyBundleAuthority.js';
import { createFilesKeyBundleRouter } from '../filesKeyBundleRoutes.js';
import type { LocalVaultAuthority } from '../localAuthority.js';
import type { PostgresVaultHealthRepository } from '../repositories/PostgresVaultHealthRepository.js';
import type { VaultRequestInput } from './VaultRequestInput.js';

/**
 * Health, the Files key-bundle API, and the Desktop control routes (backup credentials,
 * bootstrap unlock, cache update, status, lock, legacy migration), in their original order.
 */
export class DesktopControlRoutes {
  constructor(
    private readonly config: VaultConfig,
    private readonly localAuthority: LocalVaultAuthority,
    private readonly filesKeyBundleAuthority: VaultFilesKeyBundleAuthority,
    private readonly health: PostgresVaultHealthRepository,
    private readonly input: VaultRequestInput,
  ) {}

  register(app: express.Express): void {
    const { config, localAuthority, filesKeyBundleAuthority, health } = this;
    const { requiredString, safeTokenEqual, serviceIdentity } = this.input;

    app.get('/healthz', async(_request, response) => {
      try {
        await health.ping();
      } catch (error) {
        // Report unhealthy while Postgres is down; keep the process (and logs) calm.
        if (!isTransientDbError(error)) throw error;
        warnDatabaseUnavailable(error);
        response.status(503).json({ ok: false, error: 'database_unavailable' });
        return;
      }
      response.json({ ok: true, mode: config.mode });
    });

    app.use('/v1/desktop/files', createFilesKeyBundleRouter(filesKeyBundleAuthority!, {
      serviceId: config.filesServiceId!,
      token: config.filesServiceToken!,
    },(id,target)=>localAuthority.backupCredentials(id,'s3',target)));
    app.post('/v1/desktop/backup-credentials',async(request,response)=>{
      const identity=serviceIdentity(request);
      if(identity.serviceId!==config.approvalServiceId || !safeTokenEqual(identity.token,config.approvalServiceToken)) return response.sendStatus(401);
      response.setHeader('Cache-Control','no-store');
      response.json(await localAuthority.backupCredentials(requiredString(request.body.itemId,'itemId'),'nas',requiredString(request.body.target,'target')));
    });
    app.post('/v1/desktop/bootstrap/challenge', (request, response) => {
      response.json(localAuthority.createChallenge(
        requiredString(request.body.callerId, 'callerId'),
        requiredString(request.body.clientNonce, 'clientNonce'),
        requiredString(request.body.clientProof, 'clientProof'),
      ));
    });
    app.post('/v1/desktop/bootstrap/unlock', async(request, response) => {
      response.json(await localAuthority.unlock({
        callerId: requiredString(request.body.callerId, 'callerId'),
        challengeId: requiredString(request.body.challengeId, 'challengeId'),
        clientProof: requiredString(request.body.clientProof, 'clientProof'),
        sealedUnlock: requiredString(request.body.sealedUnlock, 'sealedUnlock'),
      }));
    });
    app.post('/v1/desktop/cache/challenge', (request, response) => {
      response.json(localAuthority.createCacheUpdateChallenge(
        requiredString(request.body.callerId, 'callerId'),
        requiredString(request.body.clientNonce, 'clientNonce'),
        requiredString(request.body.clientProof, 'clientProof'),
      ));
    });
    app.post('/v1/desktop/cache/fetch', (request, response) => {
      response.json(localAuthority.fetchCacheUpdate({
        callerId: requiredString(request.body.callerId, 'callerId'),
        challengeId: requiredString(request.body.challengeId, 'challengeId'),
        clientProof: requiredString(request.body.clientProof, 'clientProof'),
        sealedLegacyVmk: typeof request.body.sealedLegacyVmk === 'string' ? request.body.sealedLegacyVmk : undefined,
      }));
    });
    app.get('/v1/desktop/status', async(request, response) => {
      const identity = serviceIdentity(request);
      localAuthority.requireControlIdentity(identity.serviceId, identity.token);
      const status = localAuthority.status();
      const setupRequired = !status.unlocked && await localAuthority.isSetupRequired();
      response.json({ ...status, setup: { required: setupRequired }, migration: { required: status.state === 'migration_required', error: status.state === 'migration_failed' ? 'migration_failed' : undefined } });
    });
    app.post('/v1/desktop/lock', async(request, response) => {
      const identity = serviceIdentity(request);
      localAuthority.requireControlIdentity(identity.serviceId, identity.token);
      await localAuthority.lock();
      response.json({ state: 'locked', unlocked: false, migration: { required: false } });
    });
    app.post('/v1/desktop/migrate', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.migrateLegacy(identity.serviceId, identity.token));
    });
  }
}
