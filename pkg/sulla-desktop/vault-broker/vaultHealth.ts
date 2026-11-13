// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Last vault-side refusal seen by the provider CLI bridge.
 *
 * A provider CLI (Claude Code, Codex) runs in another process and only sees a
 * failed HTTP request; when it exits, the reason (vault locked or out of
 * reach) is lost. The bridge records it here so CLI recovery can report the
 * real cause instead of "stopped after its recovery attempts".
 */

export type VaultFailureKind = 'locked' | 'unreachable';

interface VaultFailureRecord { kind: VaultFailureKind; at: number }

let lastFailure: VaultFailureRecord | undefined;

/** Maps a bridge failure (HTTP status and non-secret reason code) to a vault cause, if it is one. */
export function vaultFailureKind(status: number | undefined, reason: string | undefined): VaultFailureKind | undefined {
  if (status === 423 || reason === 'vault_locked') return 'locked';
  if (reason && (reason.startsWith('vault_unreachable_') || reason === 'vault_starting' || reason === 'vault_unavailable')) return 'unreachable';

  return undefined;
}

export function recordVaultFailure(kind: VaultFailureKind, now = Date.now()): void {
  lastFailure = { kind, at: now };
}

/** A request got through the vault, so any earlier refusal is over. */
export function recordVaultSuccess(): void {
  lastFailure = undefined;
}

/** The vault cause recorded at or after `since` (ms epoch), if any. */
export function vaultFailureSince(since: number): VaultFailureKind | undefined {
  return lastFailure && lastFailure.at >= since ? lastFailure.kind : undefined;
}
