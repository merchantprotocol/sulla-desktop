// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { RandomUuidGenerator } from '@sulla/foundation';

import { issueLocalBrokerContext, requireConfiguredCredentialBroker } from '../../../vault-broker';
import type { IntegrationService } from '../../services/IntegrationService';
import type { BrokeredModelHttpTransport, BrokeredModelListRequest } from './BrokeredModelCatalogService';
import type { IntegrationAccountCatalogRepository } from './BrokeredModelCatalogStrategies';
import type { IdGenerator } from '@sulla/foundation';

const REQUEST_TIMEOUT_MS = 10_000;

export class IntegrationServiceAccountCatalogRepository implements IntegrationAccountCatalogRepository {
  constructor(private readonly integrations: IntegrationService) {}

  list(providerId: string) {
    return this.integrations.getAccounts(providerId);
  }

  metadata(providerId: string, accountId: string) {
    return this.integrations.getMetadataValues(providerId, accountId);
  }
}

export class VaultBrokeredModelHttpTransport implements BrokeredModelHttpTransport {
  constructor(private readonly ids: IdGenerator = new RandomUuidGenerator()) {}

  async execute(request: BrokeredModelListRequest): Promise<unknown> {
    const base = await issueLocalBrokerContext({
      agentId: 'sulla',
      podId: `sulla-model-list-${this.ids.next()}`,
      credentialScope: { integration_id: request.providerId, account_id: request.accountId },
      threadId: `model-list-${this.ids.next()}`,
      jobId: `model-list-${this.ids.next()}`,
    });
    const { getDesktopDeviceId } = await import('@pkg/main/deviceIdentity');
    const context = { ...base, device_id: await getDesktopDeviceId() };
    const broker = requireConfiguredCredentialBroker();
    const result = await broker.execute(broker.requestFor(context, {
      operation: 'provider.models',
      ref: { integrationId: request.providerId, accountId: request.accountId },
      url: request.url,
      method: 'GET',
      headers: request.headers,
      injections: request.injections,
      responseType: 'json',
    }), AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    if (result.status < 200 || result.status >= 300) throw new Error(`upstream HTTP ${result.status}`);
    return result.body;
  }
}
