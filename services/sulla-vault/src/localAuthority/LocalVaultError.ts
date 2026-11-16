// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The local authority's typed failure: a stable code, the HTTP status, and an optional non-secret reason. */
export class LocalVaultError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    /** Non-secret diagnostic reason (e.g. `connect_ECONNREFUSED`) surfaced to broker callers. */
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'LocalVaultError';
  }
}
