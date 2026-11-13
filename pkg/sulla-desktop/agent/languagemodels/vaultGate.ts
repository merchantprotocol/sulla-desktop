// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Lets CLI recovery tell a vault outage apart from a provider fault, and wait
 * for the vault to come back instead of spending retries that cannot succeed.
 */

import { recordVaultSuccess, vaultFailureSince, type VaultFailureKind } from '@pkg/vault-broker/vaultHealth';

export interface VaultGate {
  /** Vault cause recorded by the provider bridge at or after `since` (ms epoch). */
  failureSince(since: number): VaultFailureKind | undefined;
  /** Resolves true once the vault answers and is unlocked; false on timeout or abort. */
  waitUntilAvailable(signal?: AbortSignal): Promise<boolean>;
}

/** How long a run waits for the vault before reporting it, e.g. while the user unlocks. */
export const VAULT_WAIT_TIMEOUT_MS = 15 * 60_000;
const VAULT_POLL_MS = 3_000;

async function vaultAvailable(): Promise<boolean> {
  try {
    const { requireConfiguredCredentialBroker } = await import('@pkg/vault-broker');
    const status = await requireConfiguredCredentialBroker().status(AbortSignal.timeout(5_000));

    return status.unlocked === true;
  } catch {
    return false;
  }
}

export function createVaultGate(timeoutMs = VAULT_WAIT_TIMEOUT_MS, pollMs = VAULT_POLL_MS): VaultGate {
  return {
    failureSince: vaultFailureSince,
    async waitUntilAvailable(signal) {
      const deadline = Date.now() + timeoutMs;

      while (!signal?.aborted) {
        if (await vaultAvailable()) {
          recordVaultSuccess();

          return true;
        }
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, pollMs).unref?.());
      }

      return false;
    },
  };
}
