// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getVaultKeyService } from '@pkg/agent/services/VaultKeyService';
import { getFirstRunState } from '@pkg/main/firstRun/firstRunState';
import { SilentVaultRestoreTransport } from '@pkg/main/silentVaultRestoreTransport';
import { VAULT_HTTPS_ORIGIN } from '@pkg/main/vaultTls';
import { LocalVaultBrokerClient, configuredVaultBrokerProvider } from '@pkg/vault-broker';
import { desktopVaultFetch, loadDesktopBrokerIdentity } from '@pkg/vault-broker/desktopTransport';

/** Installs the Desktop-only broker transport before any feature can use it. */
export class SignedInVaultBrokerConfigurator {
  configure(): void {
    const transport = new SilentVaultRestoreTransport(desktopVaultFetch, () => this.restoreVaultSession()).fetch;

    configuredVaultBrokerProvider.configureCredentialBroker(new LocalVaultBrokerClient(VAULT_HTTPS_ORIGIN, async() => {
      const identity = await loadDesktopBrokerIdentity();

      return { serviceId: identity.serviceId, serviceToken: identity.serviceToken };
    }, transport));
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
