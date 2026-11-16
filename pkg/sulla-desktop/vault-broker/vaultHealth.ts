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

export class VaultHealthMonitor {
  private lastFailure: VaultFailureRecord | undefined;

  /** Maps a bridge failure (HTTP status and non-secret reason code) to a vault cause, if it is one. */
  static failureKind(status: number | undefined, reason: string | undefined): VaultFailureKind | undefined {
    if (status === 423 || reason === 'vault_locked') return 'locked';
    if (reason && (reason.startsWith('vault_unreachable_') || reason === 'vault_starting' || reason === 'vault_unavailable')) return 'unreachable';

    return undefined;
  }

  record(kind: VaultFailureKind, now = Date.now()): void {
    this.lastFailure = { kind, at: now };
  }

  /** A request got through the vault, so any earlier refusal is over. */
  recordSuccess(): void {
    this.lastFailure = undefined;
  }

  /** The vault cause recorded at or after `since` (ms epoch), if any. */
  failureSince(since: number): VaultFailureKind | undefined {
    return this.lastFailure && this.lastFailure.at >= since ? this.lastFailure.kind : undefined;
  }
}

/** Process-wide monitor shared by the provider bridge and CLI recovery (same main process). */
export const vaultHealthMonitor = new VaultHealthMonitor();

/** @deprecated use vaultHealthMonitor.record(); removed in the final OOP cleanup PR. */
export const recordVaultFailure = (kind: VaultFailureKind, now?: number): void => vaultHealthMonitor.record(kind, now);

/** @deprecated use vaultHealthMonitor.recordSuccess(); removed in the final OOP cleanup PR. */
export const recordVaultSuccess = (): void => vaultHealthMonitor.recordSuccess();

/** @deprecated use vaultHealthMonitor.failureSince(); removed in the final OOP cleanup PR. */
export const vaultFailureSince = (since: number): VaultFailureKind | undefined => vaultHealthMonitor.failureSince(since);

/** @deprecated use VaultHealthMonitor.failureKind(); removed in the final OOP cleanup PR. */
export const vaultFailureKind = (status: number | undefined, reason: string | undefined): VaultFailureKind | undefined =>
  VaultHealthMonitor.failureKind(status, reason);
