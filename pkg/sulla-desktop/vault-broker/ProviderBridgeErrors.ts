// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Seconds a provider CLI should wait before retrying a transient Sulla-side
 * bridge failure. Lives in this leaf module (not providerCliBridge.ts) because
 * ProviderCliBridgeService reads it at load time, and providerCliBridge.ts
 * re-exports that service: through the import cycle it was still undefined.
 */
export const PROVIDER_BRIDGE_RETRY_AFTER_SECONDS = 5;

/**
 * A provider bridge refusal with a short, non-secret reason code. The code is
 * written to the bridge log line and returned to the CLI so denials can be
 * counted by cause instead of collapsing into one generic type.
 */
export class ProviderBridgeIdentityError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'ProviderBridgeIdentityError';
  }
}

/**
 * The live authorization check could not run (for example Redis was briefly
 * unreachable while reading the revocation key). This says nothing about the
 * job: the bridge answers 503 + Retry-After and keeps the lease alive instead
 * of revoking it as an identity change.
 */
export class ProviderBridgeAuthorizeUnavailableError extends Error {
  readonly retryable = true;

  constructor(readonly reason: string, options?: { cause?: unknown }) {
    super(`Provider CLI bridge authorization check is unavailable (${ reason })`, options);
    this.name = 'ProviderBridgeAuthorizeUnavailableError';
  }
}

/** The CLI sent a request the bridge cannot forward (empty, oversized or non-JSON body). */
export class ProviderBridgeRequestError extends Error {
  constructor(message: string, readonly status: number, readonly reason: string) {
    super(message);
    this.name = 'ProviderBridgeRequestError';
  }
}
