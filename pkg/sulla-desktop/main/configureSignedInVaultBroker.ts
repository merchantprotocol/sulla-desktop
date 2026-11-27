// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getVaultKeyService } from '@pkg/agent/services/VaultKeyService';
import { getFirstRunState } from '@pkg/main/firstRun/firstRunState';
import { SilentVaultRestoreTransport } from '@pkg/main/silentVaultRestoreTransport';
import { VAULT_HTTPS_ORIGIN } from '@pkg/main/vaultTls';
import {
  LocalVaultBrokerClient,
  configuredVaultBrokerProvider,
  type VaultBrokerFetch,
  type VaultBrokerIdentityProvider,
  type VaultBrokerServiceProvider,
} from '@pkg/vault-broker';
import { desktopVaultFetch, desktopVaultTransport, loadDesktopBrokerIdentity } from '@pkg/vault-broker/desktopTransport';

interface SignedInVaultBrokerDependencies {
  provider?: Pick<VaultBrokerServiceProvider, 'configureCredentialBroker'>;
  identity?: VaultBrokerIdentityProvider;
  transport?: VaultBrokerFetch;
  streamTransport?: VaultBrokerFetch;
  endpoint?: string;
  restoreVaultSession?: () => Promise<boolean>;
}

/** Installs the Desktop-only broker transport before any feature can use it. */
export class SignedInVaultBrokerConfigurator {
  constructor(private readonly dependencies: SignedInVaultBrokerDependencies = {}) {}

  configure(): void {
    const restoreTransport = new SilentVaultRestoreTransport(
      this.dependencies.transport ?? desktopVaultFetch,
      this.dependencies.restoreVaultSession ?? (() => this.restoreVaultSession()),
    );
    const identity = this.dependencies.identity ?? (async() => {
      const loaded = await loadDesktopBrokerIdentity();

      return { serviceId: loaded.serviceId, serviceToken: loaded.serviceToken };
    });

    (this.dependencies.provider ?? configuredVaultBrokerProvider).configureCredentialBroker(new LocalVaultBrokerClient(
      this.dependencies.endpoint ?? VAULT_HTTPS_ORIGIN,
      identity,
      restoreTransport.fetch,
      restoreTransport.wrap(this.dependencies.streamTransport ?? desktopVaultTransport.fetchStream),
    ));
  }

  /** First run never attempts a vault restore. VaultKeyService delegates the safeStorage unwrap to the isolated bootstrap helper after setup. */
  private async restoreVaultSession(): Promise<boolean> {
    if (!getFirstRunState().onboardingComplete) return false;

    return getVaultKeyService().initialize();
  }
}

/** Compatibility seam for `sulla.ts`; the lifecycle registration stays where it is. */
export function configureSignedInVaultBroker(): void {
  new SignedInVaultBrokerConfigurator().configure();
}
