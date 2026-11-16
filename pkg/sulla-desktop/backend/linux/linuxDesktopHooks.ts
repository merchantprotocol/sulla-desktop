// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { ManagedServicesHooks } from './linuxManagedServices';

/** The app-level events the first-run flow and Sulla start already consume on macOS. */
export interface DesktopLifecycleEvents {
  emit(event: 'first-run-backend-booted' | 'first-run-ai-runtime-ready' | 'sulla-managed-services-ready' | 'sulla-managed-services-failed'): unknown;
}

export interface DesktopStartup {
  markDockerServicesStarted(): void;
  instantiateStart(assertCurrent: () => void): Promise<void>;
  markInstalled(): Promise<void>;
}

/** Adapts managed-services lifecycle callbacks to Desktop's main-process events. */
export class DesktopManagedServicesHooks implements ManagedServicesHooks {
  constructor(private readonly events: DesktopLifecycleEvents, private readonly startup: DesktopStartup) {}

  backendBooted(): void {
    this.events.emit('first-run-backend-booted');
  }

  coreServicesReady(): void {
    this.events.emit('first-run-ai-runtime-ready');
  }

  async servicesDeployed(assertCurrent: () => void): Promise<void> {
    this.startup.markDockerServicesStarted();
    assertCurrent();
    await this.startup.instantiateStart(assertCurrent);
    await this.startup.markInstalled();
  }

  servicesReady(): void {
    this.events.emit('sulla-managed-services-ready');
  }

  servicesFailed(): void {
    this.events.emit('sulla-managed-services-failed');
  }
}
