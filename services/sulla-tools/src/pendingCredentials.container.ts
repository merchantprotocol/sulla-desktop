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

/**
 * Desktop-only writers. Shared OAuth and cloud-session modules import these at load time, so the image
 * must export them. Writes fail closed: a container must never accept first-run credentials it cannot
 * persist, so the caller gets an error instead of a silent drop.
 */
export async function queuePendingCredential(_entry: PendingCredential): Promise<void> {
  throw new Error('First-run credentials are only held by the Desktop main process, not the Tools container');
}

export async function clearPendingCredential(_integrationId: string): Promise<void> {
  // Nothing is ever queued here, so there is nothing to clear.
}

export function startPendingCredentialFlush(): void {
  // The container has no first-run store to flush.
}
