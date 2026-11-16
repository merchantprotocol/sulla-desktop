// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { AccountsIpc } from './AccountsIpc';
import { ApplicationServiceRegistrations } from './ApplicationServiceRegistrations';
import { BrowserTabCdpIpc } from './BrowserTabCdpIpc';
import { BrowserTabViewIpc } from './BrowserTabViewIpc';
import { CoreServiceRegistrations } from './CoreServiceRegistrations';
import { DesktopServiceStartupHooks } from './DesktopServiceStartupHooks';
import { DockerServicesSession } from './DockerServicesSession';
import { MainProcessBootstrapIpc } from './MainProcessBootstrapIpc';
import { MainProcessIpcStartup } from './MainProcessIpcContext';
import { RuntimeIpc } from './RuntimeIpc';
import { ServiceLifecycleStartup } from './ServiceLifecycleStartup';
import { SullaShutdown } from './SullaShutdown';
import { VaultServiceRegistrations } from './VaultServiceRegistrations';
import { VaultKeyIpc } from './VaultKeyIpc';
import { DesktopVaultStateDependencies, VaultStateCoordinator } from './VaultStateCoordinator';
import { VaultTransferIpc } from './VaultTransferIpc';
import { VaultViewIpc } from './VaultViewIpc';
import { WindowContextInitializer } from './WindowContextInitializer';

/**
 * Composition root for Sulla's startup and shutdown. Constructing it does no
 * work; sulla.ts builds one instance and its exports delegate here.
 */
export class SullaStartup {
  readonly dockerServices = new DockerServicesSession();
  readonly vaultState = new VaultStateCoordinator(new DesktopVaultStateDependencies());
  readonly windowContext = new WindowContextInitializer();
  readonly shutdown = new SullaShutdown();
  readonly coreServices = new CoreServiceRegistrations();
  // Registration order is load-bearing: it is the order ServiceLifecycleManager sees.
  readonly services = new ServiceLifecycleStartup(new DesktopServiceStartupHooks(), [
    this.coreServices,
    new ApplicationServiceRegistrations(),
    new VaultServiceRegistrations(this.vaultState),
  ]);

  // onMainProxyLoad steps, in the order sulla.ts registered them. Later steps
  // read services earlier ones resolved (tab views, vault key, vault status).
  readonly mainProcessIpc = new MainProcessIpcStartup([
    new MainProcessBootstrapIpc(),
    new BrowserTabCdpIpc(),
    new BrowserTabViewIpc(),
    new AccountsIpc(),
    new VaultViewIpc(),
    new VaultKeyIpc(),
    new RuntimeIpc(),
    new VaultTransferIpc(),
  ]);
}
