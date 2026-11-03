// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getVaultKeyService } from '@pkg/agent/services/VaultKeyService';
import { getFirstRunState } from '@pkg/main/firstRun/firstRunState';
import { withSilentVaultRestore } from '@pkg/main/silentVaultRestoreTransport';
import { VAULT_HTTPS_ORIGIN } from '@pkg/main/vaultTls';
import { configureCredentialBroker, LocalVaultBrokerClient } from '@pkg/vault-broker';
import { desktopVaultFetch, loadDesktopBrokerIdentity } from '@pkg/vault-broker/desktopTransport';

/** Install the Desktop-only broker transport before any feature can use it. */
export function configureSignedInVaultBroker(): void {
  const transport = withSilentVaultRestore(desktopVaultFetch, async() => {
    // First run never attempts a vault restore. VaultKeyService delegates the
    // safeStorage unwrap to the isolated bootstrap helper after setup.
    if (!getFirstRunState().onboardingComplete) return false;

    return getVaultKeyService().initialize();
  });

  configureCredentialBroker(new LocalVaultBrokerClient(VAULT_HTTPS_ORIGIN, async() => {
    const identity = await loadDesktopBrokerIdentity();

    return { serviceId: identity.serviceId, serviceToken: identity.serviceToken };
  }, transport));
}
