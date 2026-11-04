// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Compatibility facade for callers and the vault-policy parity check. Provider
// behavior is owned by injected catalog strategies.

import { brokeredModelCatalogProvider } from '../app/Providers/BrokeredModelCatalogServiceProvider';

import type { ModelListLane } from '../app/Services/BrokeredModelCatalogStrategies';

export type { ModelListLane };

export function modelListLane(providerId: string, accountId: string): ModelListLane | null {
  return brokeredModelCatalogProvider.catalog.lane(providerId, accountId);
}
