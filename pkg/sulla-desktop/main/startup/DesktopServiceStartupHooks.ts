// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { getServiceLifecycleManager, type ServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { bootstrapSullaHome } from '@pkg/agent/utils/sullaPaths';

import type { ServiceStartupHooks } from './ServiceLifecycleStartup';

/** Production pre-registration steps, called exactly as sulla.ts called them. */
export class DesktopServiceStartupHooks implements ServiceStartupHooks {
  async configureSignedInVaultBroker(): Promise<void> {
    const { configureSignedInVaultBroker } = await import('@pkg/main/configureSignedInVaultBroker');

    configureSignedInVaultBroker();
  }

  async bootstrapSullaHome(): Promise<void> {
    await bootstrapSullaHome();
  }

  lifecycle(): ServiceLifecycleManager {
    return getServiceLifecycleManager();
  }
}
