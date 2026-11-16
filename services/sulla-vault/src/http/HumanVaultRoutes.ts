// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { VaultConfig } from '../config.js';
import type { LocalVaultAuthority } from '../localAuthority.js';
import type { HumanActivityRoutes } from './HumanActivityRoutes.js';
import type { VaultRequestInput } from './VaultRequestInput.js';

/**
 * The human vault UI API: session creation (service-authenticated), then the /v1/human origin
 * guard, then every cookie+CSRF route (session, unlock, password, recovery, backup, items,
 * Bitwarden import, activity), in their original order.
 */
export class HumanVaultRoutes {
  constructor(
    private readonly config: VaultConfig,
    private readonly localAuthority: LocalVaultAuthority,
    private readonly activity: HumanActivityRoutes,
    private readonly input: VaultRequestInput,
  ) {}

  register(app: express.Express): void {
    const { config, localAuthority } = this;
    const { requiredString, requiredObject, serviceIdentity, humanCookie, setHumanCookie } = this.input;

    app.post('/v1/human/session', (request, response) => {
      const identity = serviceIdentity(request);
      const target = request.body?.browserTarget;
      const session = localAuthority.createHumanSession(identity.serviceId, identity.token, target ? {
        tabId: requiredString(target.tabId, 'browserTarget.tabId'),
        origin: requiredString(target.origin, 'browserTarget.origin'),
      } : undefined);
      const fragment = new URLSearchParams({ grant: session.sessionId, csrf: session.csrf }).toString();
      response.json({ url: `${ config.humanUiOrigin }/vault/#${ fragment }`, csrf: session.csrf, expiresAt: session.expiresAt, phase: session.phase });
    });
    app.use('/v1/human', (request, response, next) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const origin = request.header('origin');
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      const fetchSite = request.header('sec-fetch-site');
      if ((unsafe && origin !== config.humanUiOrigin) || (!unsafe && origin && origin !== config.humanUiOrigin) ||
          (fetchSite && fetchSite !== 'same-origin')) {
        response.status(403).json({ error: 'invalid_origin', message: 'Human vault origin is invalid' });
        return;
      }
      if (origin) response.setHeader('Access-Control-Allow-Origin', config.humanUiOrigin!);
      response.setHeader('Vary', 'Origin');
      next();
    });
    app.post('/v1/human/session/exchange', async(request, response) => {
      const session = localAuthority.exchangeHumanGrant(
        requiredString(request.body.grant, 'grant'), requiredString(request.body.csrf, 'csrf'),
      );
      setHumanCookie(response, session.sessionId, session.expiresAt);
      const setupRequired = session.phase === 'pre-unlock' && await localAuthority.isSetupRequired();
      response.json({ csrf: session.csrf, expiresAt: session.expiresAt, phase: session.phase, targetOrigin: session.browserTarget?.origin, setupRequired });
    });
    app.get('/v1/human/session', async(request, response) => {
      const status = localAuthority.humanSessionStatus(humanCookie(request), request.header('x-csrf-token'));
      const setupRequired = status.phase === 'pre-unlock' && await localAuthority.isSetupRequired();
      response.json({ ...status, setupRequired });
    });
    app.post('/v1/human/unlock', async(request, response) => {
      const result = await localAuthority.unlockHumanSession(
        humanCookie(request), request.header('x-csrf-token'), requiredString(request.body.password, 'password'),
      );
      setHumanCookie(response, result.sessionId, result.expiresAt);
      response.json({ csrf: result.csrf, expiresAt: result.expiresAt, phase: result.phase, state: result.state, cacheMode: result.cacheMode });
    });
    app.post('/v1/human/password', async(request, response) => {
      response.json(await localAuthority.changeHumanPassword(
        humanCookie(request), request.header('x-csrf-token'),
        requiredString(request.body.currentPassword, 'currentPassword'), requiredString(request.body.nextPassword, 'nextPassword'),
      ));
    });
    app.post('/v1/human/recovery/configure', async(request, response) => {
      await localAuthority.configureHumanRecovery(
        humanCookie(request), request.header('x-csrf-token'), requiredString(request.body.recoveryCode, 'recoveryCode'),
      );
      response.status(204).end();
    });
    app.post('/v1/human/recovery/unlock', async(request, response) => {
      const result = await localAuthority.recoverHumanSession(
        humanCookie(request), request.header('x-csrf-token'),
        requiredString(request.body.recoveryCode, 'recoveryCode'), requiredString(request.body.nextPassword, 'nextPassword'),
      );
      setHumanCookie(response, result.sessionId, result.expiresAt);
      response.json({ csrf: result.csrf, expiresAt: result.expiresAt, phase: result.phase, state: result.state, cacheMode: result.cacheMode });
    });
    app.post('/v1/human/backup/export', async(request, response) => {
      response.json(await localAuthority.exportHumanBackup(
        humanCookie(request), request.header('x-csrf-token'), requiredString(request.body.backupPassword, 'backupPassword'),
      ));
    });
    app.post('/v1/human/backup/import', async(request, response) => {
      await localAuthority.importHumanBackup(
        humanCookie(request), request.header('x-csrf-token'), requiredString(request.body.backupPassword, 'backupPassword'),
        requiredObject(request.body.backup, 'backup') as any,
      );
      response.status(204).end();
    });
    app.post('/v1/human/lock', async(request, response) => {
      const result = await localAuthority.lockHumanSession(humanCookie(request), request.header('x-csrf-token'));
      setHumanCookie(response, result.sessionId, result.expiresAt);
      response.json({ csrf: result.csrf, expiresAt: result.expiresAt, phase: result.phase, state: result.state });
    });
    app.get('/v1/human/items', async(request, response) => {
      response.json({ items: await localAuthority.listHumanItems(humanCookie(request), request.header('x-csrf-token')) });
    });
    app.post('/v1/human/import/bitwarden/preview', async(request,response)=>{
      response.json(await localAuthority.previewBitwardenImport(humanCookie(request),request.header('x-csrf-token'),request.body));
    });
    app.post('/v1/human/import/bitwarden', async(request,response)=>{
      response.json(await localAuthority.importBitwarden(humanCookie(request),request.header('x-csrf-token'),request.body));
    });
    this.activity.register(app);
    app.post('/v1/human/items', async(request, response) => {
      const result = await localAuthority.saveHumanItem(humanCookie(request), request.header('x-csrf-token'), request.body);
      response.status(201).json(result);
    });
    app.post('/v1/human/items/:itemId/reveal', async(request, response) => {
      const itemId = requiredString(request.params.itemId, 'itemId');
      const result = await localAuthority.revealHumanItem(humanCookie(request), request.header('x-csrf-token'), itemId);
      response.json(result);
    });
    app.patch('/v1/human/items/:itemId', async(request, response) => {
      const itemId = requiredString(request.params.itemId, 'itemId');
      const result = await localAuthority.saveHumanItem(humanCookie(request), request.header('x-csrf-token'), { ...request.body, id: itemId });
      response.json(result);
    });
    app.delete('/v1/human/items/:itemId', async(request, response) => {
      const itemId = requiredString(request.params.itemId, 'itemId');
      await localAuthority.deleteHumanItem(humanCookie(request), request.header('x-csrf-token'), itemId, Number(request.query.revision));
      response.status(204).end();
    });
  }
}
