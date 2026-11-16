// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Lets CLI recovery tell a vault outage apart from a provider fault, and wait
 * for the vault to come back instead of spending retries that cannot succeed.
 */

import { vaultHealthMonitor, type VaultFailureKind, type VaultHealthMonitor } from '@pkg/vault-broker/vaultHealth';

export interface VaultGate {
  /** Vault cause recorded by the provider bridge at or after `since` (ms epoch). */
  failureSince(since: number): VaultFailureKind | undefined;
  /** Resolves true once the vault answers and is unlocked; false on timeout or abort. */
  waitUntilAvailable(signal?: AbortSignal): Promise<boolean>;
}

/** How long a run waits for the vault before reporting it, e.g. while the user unlocks. */
export const VAULT_WAIT_TIMEOUT_MS = 15 * 60_000;
const VAULT_POLL_MS = 3_000;

/** Resolves true when the vault answers and is unlocked. */
export type VaultAvailabilityProbe = () => Promise<boolean>;

export class VaultAvailabilityGate implements VaultGate {
  constructor(
    private readonly health: VaultHealthMonitor = vaultHealthMonitor,
    private readonly timeoutMs = VAULT_WAIT_TIMEOUT_MS,
    private readonly pollMs = VAULT_POLL_MS,
    private readonly probe: VaultAvailabilityProbe = VaultAvailabilityGate.brokerUnlocked,
  ) {}

  /** Default probe: asks the configured credential broker whether the vault is unlocked. */
  static async brokerUnlocked(): Promise<boolean> {
    try {
      const { configuredVaultBrokerProvider } = await import('@pkg/vault-broker');
      const status = await configuredVaultBrokerProvider.requireConfiguredCredentialBroker().status(AbortSignal.timeout(5_000));

      return status.unlocked === true;
    } catch {
      return false;
    }
  }

  failureSince(since: number): VaultFailureKind | undefined {
    return this.health.failureSince(since);
  }

  async waitUntilAvailable(signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + this.timeoutMs;

    while (!signal?.aborted) {
      if (await this.probe()) {
        this.health.recordSuccess();

        return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, this.pollMs).unref?.());
    }

    return false;
  }
}

/** @deprecated use new VaultAvailabilityGate(); removed in the final OOP cleanup PR. */
export const createVaultGate = (timeoutMs = VAULT_WAIT_TIMEOUT_MS, pollMs = VAULT_POLL_MS): VaultGate =>
  new VaultAvailabilityGate(vaultHealthMonitor, timeoutMs, pollMs);
