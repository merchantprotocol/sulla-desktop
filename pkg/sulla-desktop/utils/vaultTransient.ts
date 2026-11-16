// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Connection errors that mean "the vault container is still (re)starting", not "the vault is broken". */
const TRANSIENT_PATTERN = /ERR_CONNECTION_(REFUSED|CLOSED|RESET|TIMED_OUT)|ECONN(REFUSED|RESET)|ETIMEDOUT|EPIPE|socket hang up|Vault service is unavailable/i;

export interface VaultRetryOptions {
  attempts?: number;
  delayMs?: number;
  shouldContinue?: () => boolean;
}

/** Classifies errors that mean the vault is still starting. Stateless; safe to share. */
export class VaultTransientErrorPolicy {
  isTransient(cause: unknown): boolean {
    const message = cause instanceof Error ? cause.message : String(cause ?? '');

    return TRANSIENT_PATTERN.test(message);
  }
}

/** Runs work and retries it while it fails with a transient vault connection error. */
export class VaultRetryRunner {
  constructor(
    private readonly policy: VaultTransientErrorPolicy = new VaultTransientErrorPolicy(),
    private readonly wait: (ms: number) => Promise<void> = delay,
  ) {}

  async run<T>(
    work: () => Promise<T>,
    { attempts = 8, delayMs = 1_500, shouldContinue = () => true }: VaultRetryOptions = {},
  ): Promise<T> {
    let last: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await work();
      } catch (error) {
        last = error;
        if (!this.policy.isTransient(error) || attempt === attempts || !shouldContinue()) throw error;
        await this.wait(delayMs);
      }
    }

    throw last;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Stateless defaults for callers that do not inject their own policy. The renderer imports this
// module too, so it must not pull in Electron-only services.
const defaultPolicy = new VaultTransientErrorPolicy();
const defaultRunner = new VaultRetryRunner(defaultPolicy);

/** Compatibility seam for existing callers; prefer injecting a `VaultRetryRunner`. */
export function isTransientVaultError(cause: unknown): boolean {
  return defaultPolicy.isTransient(cause);
}

/** Compatibility seam for existing callers; prefer injecting a `VaultRetryRunner`. */
export function retryTransientVault<T>(work: () => Promise<T>, options: VaultRetryOptions = {}): Promise<T> {
  return defaultRunner.run(work, options);
}
