// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Container-side authority for main-process-only first-run credentials.
 *
 * A tools container can use credentials only through the vault broker. It must
 * never see the temporary credentials held in Electron memory during first run.
 * Agent modules share code with Electron and make optional lookups here, so the
 * container deliberately reports an empty store.
 */
export interface PendingCredential {
  integrationId: string;
  accountId: string;
  values: Record<string, string>;
  activate?: boolean;
}

export function getPendingCredential(_integrationId: string): PendingCredential | undefined {
  return undefined;
}

export function hasPendingCredential(_integrationId: string): boolean {
  return false;
}
