// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { LocalVaultAuthority } from '../localAuthority.js';
import type { VaultRequestInput } from './VaultRequestInput.js';

/** Service-authenticated broker routes: approvals, status, agent vault items and integration accounts. */
export class BrokerItemRoutes {
  constructor(
    private readonly localAuthority: LocalVaultAuthority,
    private readonly input: VaultRequestInput,
  ) {}

  register(app: express.Express): void {
    const { localAuthority } = this;
    const { requiredString, serviceIdentity } = this.input;

    app.post('/v1/broker/approve', (request, response) => {
      const identity = serviceIdentity(request);
      response.json(localAuthority.approve(identity.serviceId, identity.token, requiredString(request.body.operationId, 'operationId')));
    });
    app.get('/v1/broker/status', (request, response) => {
      const identity = serviceIdentity(request);
      response.json(localAuthority.brokerStatus(identity.serviceId, identity.token));
    });
    app.post('/v1/broker/items', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.listBrokerItems(request.body.claims, identity.serviceId, identity.token));
    });
    app.post('/v1/broker/items/create', async(request, response) => {
      const identity = serviceIdentity(request);
      response.status(201).json(await localAuthority.createAgentVaultItem(identity.serviceId, identity.token, request.body));
    });
    app.patch('/v1/broker/items/:itemId', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.updateAgentVaultItem(identity.serviceId, identity.token, { ...request.body, itemId: requiredString(request.params.itemId, 'itemId') }));
    });
    app.put('/v1/broker/integrations/:integrationId/credential', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.setAgentIntegrationCredential(identity.serviceId, identity.token, { ...request.body, integrationId: requiredString(request.params.integrationId, 'integrationId') }));
    });
    app.get('/v1/broker/integrations/:integrationId/metadata', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.integrationMetadata(
        identity.serviceId, identity.token, requiredString(request.params.integrationId, 'integrationId'),
        typeof request.query.accountId === 'string' ? request.query.accountId : undefined,
      ));
    });
    app.put('/v1/broker/integrations/:integrationId/active-account', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.setActiveIntegrationAccount(
        identity.serviceId, identity.token, requiredString(request.params.integrationId, 'integrationId'),
        requiredString(request.body.accountId, 'accountId'),
      ));
    });
    app.put('/v1/broker/integrations/:integrationId/oauth-account', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.ensureOAuthAccount(
        identity.serviceId, identity.token, requiredString(request.params.integrationId, 'integrationId'), request.body,
      ));
    });
    app.put('/v1/broker/integrations/:integrationId/desktop-account', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.importDesktopIntegrationAccount(
        identity.serviceId, identity.token, requiredString(request.params.integrationId, 'integrationId'), request.body,
      ));
    });
  }
}
