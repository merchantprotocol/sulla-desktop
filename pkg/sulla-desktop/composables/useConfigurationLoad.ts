// SPDX-License-Identifier: GPL-2.0-or-later

import { getCurrentScope, onScopeDispose, ref } from 'vue';
import { DatabaseUnavailableClassifier } from '@pkg/agent/database/DatabaseAvailability';
import { isTransientVaultError } from '@pkg/utils/vaultTransient';

export class ConfigurationLoadPolicy {
  isVaultLocked(cause: unknown): boolean {
    return /\bvault(?: is locked|_locked)\b/i.test(cause instanceof Error ? cause.message : String(cause));
  }

  private readonly database = new DatabaseUnavailableClassifier();

  isTransient(cause: unknown): boolean {
    const message = (cause instanceof Error ? cause.message : String(cause))
      .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    return this.database.isUnavailable(cause) || this.database.isUnavailable({ message }) || isTransientVaultError(cause)
      || /temporarily unavailable while the database reconnects|did not become ready within|^Sulla is still starting its password vault\.|^Vault broker service identity is not configured$|^Workflow manager returned HTTP (502|503|504)$|^failed to fetch$|^load failed$/i.test(message);
  }
}

/** Loads configuration until its dependencies answer. Return false for an explicit not-ready result. */
export function useConfigurationLoad(load: () => Promise<void | boolean>, policy = new ConfigurationLoadPolicy()) {
  const loading = ref(true);
  const error = ref('');
  let alive = true;
  let inFlight = false;
  let reloadRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1_000;

  async function attempt(): Promise<void> {
    if (!alive || inFlight) return;
    inFlight = true;
    loading.value = true;
    error.value = '';
    let retry = false;
    try {
      retry = (await load()) === false;
    } catch (cause) {
      retry = policy.isTransient(cause);
      if (alive && !retry) error.value = cause instanceof Error ? cause.message : String(cause);
    } finally {
      inFlight = false;
    }
    if (!alive) return;
    if (reloadRequested) {
      reloadRequested = false;
      return attempt();
    }
    if (retry) {
      timer = setTimeout(() => { timer = undefined; void attempt() }, delay);
      delay = Math.min(delay * 2, 5_000);
      return;
    }
    loading.value = false;
  }

  function start(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    delay = 1_000;
    if (inFlight) reloadRequested = true;
    return attempt();
  }

  if (getCurrentScope()) onScopeDispose(() => { alive = false; clearTimeout(timer) });
  return { loading, error, start };
}
