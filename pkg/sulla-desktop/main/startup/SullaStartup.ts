// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { ApplicationServiceRegistrations } from './ApplicationServiceRegistrations';
import { CoreServiceRegistrations } from './CoreServiceRegistrations';
import { DesktopServiceStartupHooks } from './DesktopServiceStartupHooks';
import { DockerServicesSession } from './DockerServicesSession';
import { ServiceLifecycleStartup } from './ServiceLifecycleStartup';
import { SullaShutdown } from './SullaShutdown';
import { VaultServiceRegistrations } from './VaultServiceRegistrations';
import { DesktopVaultStateDependencies, VaultStateCoordinator } from './VaultStateCoordinator';
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
}
