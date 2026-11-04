// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Compatibility facade. The composition root owns the service, strategies,
// repository, transport, clock, and bounded request cache.

import { brokeredModelCatalogProvider } from '../app/Providers/BrokeredModelCatalogServiceProvider';
import { modelListLane } from './brokeredModelLanes';

import type { BrokeredModelListRequest } from '../app/Services/BrokeredModelCatalogService';
import type { ModelListLane } from './brokeredModelLanes';
import type { IntegrationAccount } from './IntegrationService';

export type { BrokeredModelListRequest, ModelListLane };

export function resolveModelListAccount(
  providerId: string,
  preferredAccountId?: string,
  accountsInput?: IntegrationAccount[],
): Promise<IntegrationAccount | null> {
  return brokeredModelCatalogProvider.catalog.resolveAccount(providerId, preferredAccountId, accountsInput);
}

export function fetchBrokeredModelList<T = unknown>(request: BrokeredModelListRequest): Promise<T | null> {
  return brokeredModelCatalogProvider.catalog.fetch<T>(request);
}

export function clearBrokeredModelListCache(): void {
  brokeredModelCatalogProvider.catalog.clear();
}

export function listProviderModelsBrokered<T = unknown>(
  providerId: string,
  preferredAccountId?: string,
  extraHeaders?: (lane: ModelListLane) => Record<string, string>,
): Promise<{ body: T | null; lane: ModelListLane | null }> {
  return brokeredModelCatalogProvider.catalog.list<T>(providerId, preferredAccountId, extraHeaders);
}

export { modelListLane };
