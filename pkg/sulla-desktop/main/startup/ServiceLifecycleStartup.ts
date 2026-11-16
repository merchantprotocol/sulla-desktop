// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import Logging from '@pkg/utils/logging';

import type { LifecycleRegistrationProvider } from './LifecycleRegistrationProvider';

const console = Logging.sulla;

/** Steps that run before any service registers; production wiring loads them lazily. */
export interface ServiceStartupHooks {
  configureSignedInVaultBroker(): Promise<void>;
  bootstrapSullaHome(): Promise<void>;
  lifecycle(): ServiceLifecycleManager;
}

/**
 * Registers every lifecycle service group in a fixed order, then starts them.
 * The provider order is the registration order ServiceLifecycleManager sees.
 */
export class ServiceLifecycleStartup {
  constructor(
    private readonly hooks: ServiceStartupHooks,
    private readonly providers: readonly LifecycleRegistrationProvider[],
  ) {}

  async start(assertCurrent?: () => void): Promise<void> {
    console.log('[Integrations] Sulla integrations initialized');

    await this.hooks.configureSignedInVaultBroker();

    // NOTE: initSullaEvents() is now called in background.ts before initUI()
    // so handlers are registered before any window can invoke them.

    await this.hooks.bootstrapSullaHome();

    const lifecycle = this.hooks.lifecycle();

    for (const provider of this.providers) {
      provider.register(lifecycle);
    }

    // MCP servers are initialized lazily — on first tool listing or tool call.
    console.log('[Background] MCP servers will initialize on first use (lazy init)');

    try {
      await lifecycle.startAll(assertCurrent);
    } catch (ex: any) {
      console.error('[Background] Failed to initialize Sulla:', ex);
      if (assertCurrent) throw ex;
    }
  }
}
