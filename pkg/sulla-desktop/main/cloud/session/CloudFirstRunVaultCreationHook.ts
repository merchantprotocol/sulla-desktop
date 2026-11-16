// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type {
  ContainerVaultStatus, FirstRunVaultCreationDependencies, VaultCreationDisposition,
} from '@pkg/main/firstRun/FirstRunVaultCreation';

import type { CloudAccountWrapService } from '../account/CloudAccountWrapService';

/** The lifecycle events and lock view the hook listens to (ServiceLifecycleManager). */
export interface VaultCreationLifecycle {
  on(event: 'vault:state', listener: (unlocked: boolean) => void): unknown;
  on(event: 'service:ready', listener: (name: string) => void): unknown;
  isVaultUnlocked(): boolean;
}

/** The FirstRunVaultCreation instance the hook drives. */
export interface VaultCreationRunner {
  start(): void;
  poke(): Promise<void>;
  onLifecycleLocked(): Promise<void>;
}

export interface CloudFirstRunVaultCreationPorts {
  lifecycle(): VaultCreationLifecycle;
  /** first-run-state.json holds the expired-sign-in hold (`credentialsSaved === false`). */
  holdUntilWizardCloses(): boolean;
  containerStatus(): Promise<ContainerVaultStatus>;
  /** The Cloud enrollment coordinator (DesktopVaultEnrollment.coordinator), loaded lazily. */
  enrollment(): Promise<{
    gate(): Promise<VaultCreationDisposition>;
    complete(masterKey: Uint8Array, cloudUserId: string): Promise<VaultCreationDisposition>;
  }>;
  publishUnlocked(): Promise<void>;
  trace(message: string, detail?: Record<string, unknown>): void;
  logger: { log(message: string): void; error(message: string): void };
  createRunner(dependencies: FirstRunVaultCreationDependencies): VaultCreationRunner;
}

/**
 * Installs, once per process, the first-run vault creation that turns the held
 * Cloud key into the vault as soon as the vault CONTAINER answers.
 */
export class CloudFirstRunVaultCreationHook {
  private installed = false;

  constructor(private readonly wrap: CloudAccountWrapService, private readonly ports: CloudFirstRunVaultCreationPorts) {}

  install(): void {
    if (this.installed) return;
    this.installed = true;
    const lifecycle = this.ports.lifecycle();
    // Gate on the vault CONTAINER answering, not the lifecycle 'vault' service:
    // that service waits on postgres, database-manager and the managed-services
    // reconcile, none of which creating the vault needs (see FirstRunVaultCreation).
    const creation = this.ports.createRunner({
      // First run never calls, waits on, or creates the vault while its sign-in
      // is held only in memory for a returning Cloud session.
      holdUntilWizardCloses: () => this.ports.holdUntilWizardCloses(),
      hasPendingKey:         () => this.wrap.hasPendingKey(),
      containerStatus:       () => this.ports.containerStatus(),
      lifecycleUnlocked:     () => lifecycle.isVaultUnlocked(),
      enrollmentGate:        async() => (await this.ports.enrollment()).gate(),
      enrollmentComplete:    async() => (await this.ports.enrollment()).complete(this.wrap.pendingKey()!, this.wrap.pendingUserId()!),
      createOrRewrap:        async() => {
        const creating = !lifecycle.isVaultUnlocked();
        await this.wrap.flush();
        if (creating) this.ports.logger.log('[SullaCloudAuth] Vault created from the Cloud account password and unlocked');
      },
      publishUnlocked: () => this.ports.publishUnlocked(),
      zeroKey:         () => this.wrap.clear(),
      trace:           (message, detail) => this.ports.trace(message, detail),
      logError:        message => this.ports.logger.error(message),
    });
    lifecycle.on('vault:state', (unlocked: boolean) => {
      if (unlocked) void creation.poke();
      else void creation.onLifecycleLocked();
    });
    lifecycle.on('service:ready', (name: string) => { if (name === 'vault') void creation.poke() });
    creation.start();
  }
}
