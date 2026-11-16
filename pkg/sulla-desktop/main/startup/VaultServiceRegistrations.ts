// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { SullaIntegrations } from '@pkg/agent/integrations';
import Logging from '@pkg/utils/logging';

import type { LifecycleRegistrationProvider } from './LifecycleRegistrationProvider';
import type { VaultStateCoordinator } from './VaultStateCoordinator';

const console = Logging.sulla;

/** The vault stage and every vault-gated service (Files runtime, model providers, integrations, OAuth). */
export class VaultServiceRegistrations implements LifecycleRegistrationProvider {
  readonly name = 'vault';

  constructor(private readonly vaultState: VaultStateCoordinator) {}

  register(lifecycle: ServiceLifecycleManager): void {
    lifecycle.registerOnce('vault', ['database-manager'],
      async() => {
        const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
        const { IntegrationValueModel } = await import('@pkg/agent/database/models/IntegrationValueModel');
        const vaultKeyService = getVaultKeyService();

        // Lets unlock verify a key against real ciphertext if the canary is lost.
        vaultKeyService.setCiphertextSampleProvider(() => IntegrationValueModel.sampleEncryptedValue());
        await this.vaultState.waitForContainer();
        const unlocked = await vaultKeyService.initialize();
        this.vaultState.setLifecycleInitialized(true);

        console.log(`[Background] Vault initialized: ${ unlocked ? 'unlocked' : 'locked' }`);
        await this.vaultState.publish(unlocked);
        // Files starts in its own lifecycle stage after the vault is ready.
      },
      async() => {
        const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
        const { getVaultBackupService } = await import('@pkg/agent/services/VaultBackupService');

        this.vaultState.setLifecycleInitialized(false);
        getVaultBackupService().stop();
        getVaultKeyService().lock();
        const { getSullaFilesWatcher } = await import('@pkg/main/sullaFilesWatcher');
        await getSullaFilesWatcher().lockService().catch(() => undefined);
      },
    );

    lifecycle.registerOnce('sulla-files-runtime', ['vault'],
      async() => {
        const { startSullaFilesSourceGateway, stopSullaFilesSourceGateway } = await import('@pkg/main/sullaFilesSourceGateway');
        const { getSullaFilesWatcher } = await import('@pkg/main/sullaFilesWatcher');
        const watcher = getSullaFilesWatcher();
        startSullaFilesSourceGateway();
        try {
          // Files is optional for the app to be usable: never let it hold the
          // startup screen. After the budget it keeps starting in the background.
          const { awaitWithBudget } = await import('@pkg/utils/awaitWithBudget');
          const { traceAsync, traceEvent } = await import('@pkg/utils/startupTrace');
          const filesStartup = (async() => {
            await traceAsync('startup: watcher.initialize', () => watcher.initialize());
            const { getVaultKeyService } = await import('@pkg/agent/services/VaultKeyService');
            if (getVaultKeyService().isUnlocked()) await traceAsync('startup: watcher.unlockService', () => watcher.unlockServiceWithRetry());
            else traceEvent('startup: vault locked; skipping Files unlock');
            console.log('[Background] Sulla Files runtime initialized');
          })();
          await awaitWithBudget('Sulla Files runtime', filesStartup, 20_000);
        } catch (error) {
          await watcher.shutdown().catch(() => undefined);
          await stopSullaFilesSourceGateway();
          throw error;
        }
      },
      async() => {
        const { getSullaFilesWatcher } = await import('@pkg/main/sullaFilesWatcher');
        const { stopSullaFilesSourceGateway } = await import('@pkg/main/sullaFilesSourceGateway');
        await getSullaFilesWatcher().shutdown();
        await stopSullaFilesSourceGateway();
      },
      { requiresVault: true },
    );

    lifecycle.registerOnce('model-provider', ['database-manager', 'redis'],
      async() => {
        const { getModelProviderService } = await import('@pkg/agent/services/ModelProviderService');
        const svc = getModelProviderService();

        await svc.initialize();

        // Invalidate LLM caches whenever the source of truth changes
        const { LLMRegistry } = await import('@pkg/agent/languagemodels');

        svc.onChange(() => {
          LLMRegistry.invalidate();
          console.log('[Background] LLM service caches invalidated via ModelProviderService');
        });

        console.log('[Background] ModelProviderService initialized');
      },
      async() => { /* no teardown needed */ },
      { requiresVault: true },
    );

    lifecycle.registerOnce('integrations', ['vault'],
      async() => {
        SullaIntegrations();
        const { getIntegrationConfigLoader } = await import('@pkg/agent/integrations/configApi');
        const configLoader = getIntegrationConfigLoader();

        await configLoader.loadAll();
        console.log('[Background] IntegrationConfigLoader ready:', configLoader.getAvailableIntegrations().join(', ') || '(none)');
      },
      async() => { /* no teardown */ },
      { requiresVault: true },
    );

    lifecycle.registerOnce('oauth', ['database-manager', 'vault'],
      async() => {
        const { getOAuthService } = await import('@pkg/agent/services/OAuthService');

        await getOAuthService().resumeRefreshTimers();
        console.log('[Background] OAuthService refresh timers resumed');
      },
      async() => {
        const { getOAuthService } = await import('@pkg/agent/services/OAuthService');

        getOAuthService().shutdown();
      },
      { requiresVault: true },
    );

    lifecycle.registerOnce('file-search', [],
      async() => {
        const { startFileSearchMaintenance } = await import('@pkg/main/fileSearchService');

        startFileSearchMaintenance();
        console.log('[Background] File-search index warm-up scheduled');
      },
      async() => {
        const { stopFileSearchMaintenance, closeFileSearch } = await import('@pkg/main/fileSearchService');

        stopFileSearchMaintenance();
        closeFileSearch();
      },
    );

    // The Preferences host-access checkbox persists to settings.json, but the
    // exechost/AppleScript gate reads the SullaSettingsModel dual store — push
    // the on-disk value across once the stores are reachable, so a toggle made
    // while the DB was down (or before this sync existed) still takes effect.
    lifecycle.registerOnce('host-access-sync', ['database-manager', 'redis'],
      async() => {
        const { reconcileHostAccessFromDisk } = await import('@pkg/agent/tools/util/hostAccess');

        await reconcileHostAccessFromDisk();
      },
      async() => { /* nothing to tear down */ },
    );

  }
}
