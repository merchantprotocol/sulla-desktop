// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Container persistence key of a hidden delegated thread. spawn_agent and the
 * parked-job wake path must agree on it: the key picks the workspace and
 * provider-home folder, so a mismatch hands a woken worker an empty workspace.
 */
export function delegatedThreadPersistenceKey(threadId: string): string {
  return threadId;
}
