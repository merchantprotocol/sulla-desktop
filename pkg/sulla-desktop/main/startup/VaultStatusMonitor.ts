// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import Logging from '@pkg/utils/logging';

const console = Logging.sulla;

/** The status fields the monitor reads; the vault client returns more. */
export interface VaultStatusLike {
  unlocked: boolean;
  state: string;
  cacheUpdateRequired?: boolean;
}

export interface VaultStatusClient<S extends VaultStatusLike> {
  status(): Promise<S>;
  migrate(): Promise<unknown>;
}

export interface VaultStatusMonitorDependencies<S extends VaultStatusLike> {
  client(): Promise<VaultStatusClient<S>>;
  lifecycleVaultUnlocked(): boolean;
  refreshMasterCache(): Promise<unknown>;
  publish(unlocked: boolean): Promise<void>;
  hasActiveVaultView(): boolean;
}

/**
 * Polls vault status while the vault view is open. One in-flight refresh is
 * shared between the poll and every renderer `vault:status` caller so slow or
 * missing vault responses can't pile up; one migration runs at a time.
 */
export class VaultStatusMonitor<S extends VaultStatusLike = VaultStatusLike> {
  private poll: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private migrationRun: Promise<unknown> | undefined;
  private inFlight: Promise<S> | undefined;

  constructor(private readonly deps: VaultStatusMonitorDependencies<S>, private readonly intervalMs = 1_000) {}

  refresh(): Promise<S> {
    this.inFlight ??= this.refreshOnce().finally(() => { this.inFlight = undefined });
    return this.inFlight;
  }

  startPolling(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      // Self-stop if the vault view went away without a vault:view-hide (renderer reload, crash).
      if (!this.deps.hasActiveVaultView()) {
        clearInterval(this.poll);
        this.poll = undefined;
        return;
      }
      if (this.running) return;
      this.running = true;
      void this.refresh().catch(error => console.warn('[vault] Status refresh failed:', error)).finally(() => { this.running = false });
    }, this.intervalMs);
  }

  /** The vault view was hidden; stop polling once no owner is left. */
  viewHidden(): void {
    if (!this.deps.hasActiveVaultView()) {
      if (this.poll) clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  isPolling(): boolean {
    return this.poll !== undefined;
  }

  private async refreshOnce(): Promise<S> {
    const client = await this.deps.client();
    const wasUnlocked = this.deps.lifecycleVaultUnlocked();
    let status = await client.status();
    if (status.cacheUpdateRequired && await this.deps.refreshMasterCache()) status = await client.status();
    if (status.state === 'migration_required') {
      this.migrationRun ??= client.migrate().finally(() => { this.migrationRun = undefined });
      await this.migrationRun;
      status = await client.status();
    }
    if (status.unlocked !== wasUnlocked) await this.deps.publish(status.unlocked);
    return status;
  }
}
