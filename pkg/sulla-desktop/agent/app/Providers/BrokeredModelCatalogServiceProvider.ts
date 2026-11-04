// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { SystemClock } from '@sulla/foundation';

import { getIntegrationService } from '../../services/IntegrationService';
import {
  IntegrationServiceAccountCatalogRepository,
  VaultBrokeredModelHttpTransport,
} from '../Services/BrokeredModelCatalogAdapters';
import { BrokeredModelCatalogService } from '../Services/BrokeredModelCatalogService';
import { ProviderCatalogStrategyRegistry } from '../Services/BrokeredModelCatalogStrategies';
import { ExpiringRequestCache } from '../Services/ExpiringRequestCache';

const DEFAULT_MAX_CACHE_ENTRIES = 100;

export class BrokeredModelCatalogServiceProvider {
  readonly catalog: BrokeredModelCatalogService;

  constructor() {
    const accounts = new IntegrationServiceAccountCatalogRepository(getIntegrationService());
    this.catalog = new BrokeredModelCatalogService(
      ProviderCatalogStrategyRegistry.defaults(),
      accounts,
      new VaultBrokeredModelHttpTransport(),
      new ExpiringRequestCache(new SystemClock(), DEFAULT_MAX_CACHE_ENTRIES),
      console,
    );
  }
}

export const brokeredModelCatalogProvider = new BrokeredModelCatalogServiceProvider();
