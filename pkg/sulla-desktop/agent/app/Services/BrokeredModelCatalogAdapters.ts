// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { RandomUuidGenerator } from '@sulla/foundation';

import { configuredVaultBrokerProvider } from '../../../vault-broker';
import type { IntegrationService } from '../../services/IntegrationService';
import type { BrokeredModelHttpTransport, BrokeredModelListRequest } from './BrokeredModelCatalogService';
import type { IntegrationAccountCatalogRepository } from './BrokeredModelCatalogStrategies';
import type { IdGenerator } from '@sulla/foundation';

const REQUEST_TIMEOUT_MS = 10_000;
const CODEX_CLIENT_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

function codexModelCatalogUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    const versions = parsed.searchParams.getAll('client_version');
    return parsed.protocol === 'https:' && parsed.hostname === 'chatgpt.com' && parsed.port === '' &&
      parsed.pathname === '/backend-api/codex/models' && parsed.username === '' && parsed.password === '' &&
      parsed.hash === '' && parsed.searchParams.size === 1 && versions.length === 1 && CODEX_CLIENT_VERSION.test(versions[0]);
  } catch {
    return false;
  }
}

/** Codex's subscription catalog is a fixed metadata route, never a caller URL. */
export function assertBrokeredModelCatalogUrl(request: Pick<BrokeredModelListRequest, 'providerId' | 'url'>): void {
  if (request.providerId === 'codex' && !codexModelCatalogUrlAllowed(request.url)) {
    throw new Error('Codex model catalog route is not allowed.');
  }
}

export class IntegrationServiceAccountCatalogRepository implements IntegrationAccountCatalogRepository {
  constructor(private readonly integrations: () => IntegrationService) {}

  list(providerId: string) {
    return this.integrations().getAccounts(providerId);
  }

  metadata(providerId: string, accountId: string) {
    return this.integrations().getMetadataValues(providerId, accountId);
  }
}

export class VaultBrokeredModelHttpTransport implements BrokeredModelHttpTransport {
  constructor(private readonly ids: IdGenerator = new RandomUuidGenerator()) {}

  async execute(request: BrokeredModelListRequest): Promise<unknown> {
    assertBrokeredModelCatalogUrl(request);
    const base = await configuredVaultBrokerProvider.issueLocalBrokerContext({
      agentId: 'sulla',
      podId: `sulla-model-list-${this.ids.next()}`,
      credentialScope: { integration_id: request.providerId, account_id: request.accountId },
      threadId: `model-list-${this.ids.next()}`,
      jobId: `model-list-${this.ids.next()}`,
    });
    const { getDesktopDeviceId } = await import('@pkg/main/deviceIdentity');
    const context = { ...base, device_id: await getDesktopDeviceId() };
    const broker = configuredVaultBrokerProvider.requireConfiguredCredentialBroker();
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
