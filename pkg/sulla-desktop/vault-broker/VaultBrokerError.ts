// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export class VaultBrokerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    /** Non-secret diagnostic reason from the vault, e.g. `connect_ECONNREFUSED`. */
    public readonly reason?: string,
    /** The vault marked this as a transient egress failure worth retrying after a pause. */
    public readonly retryable = false,
    /** Sanitized numeric Retry-After value from the local Vault boundary. */
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = 'VaultBrokerError';
  }
}
