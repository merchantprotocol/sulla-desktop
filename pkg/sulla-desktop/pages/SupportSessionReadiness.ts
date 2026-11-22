// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type SupportSessionConnection = 'inactive' | 'unverified' | 'checking' | 'offline' | 'connected';

/** Display readiness only. Consent and tool scope are determined separately. */
export class SupportSessionReadiness {
  connection(active: boolean, sessionVerified: boolean, presenceOnline: boolean | null | undefined): SupportSessionConnection {
    if (!active) return 'inactive';
    if (!sessionVerified || presenceOnline === null) return 'unverified';
    if (presenceOnline === undefined) return 'checking';
    return presenceOnline ? 'connected' : 'offline';
  }
}
