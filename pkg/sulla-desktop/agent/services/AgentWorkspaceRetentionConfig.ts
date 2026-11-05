// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface WorkspaceRetentionConfigOverrides {
  /** Legacy alias for terminalRetentionMs. */
  retentionWindowMs?: number;
  completedRetentionMs?: number;
  terminalRetentionMs?: number;
  minFreeDiskBytes?: number;
  intervalMs?: number;
}

/** Tunables for guest agent-workspace retention. */
export class WorkspaceRetentionConfig {
  static readonly DEFAULT_COMPLETED_RETENTION_MS = 10 * 60_000;
  static readonly DEFAULT_TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
  static readonly DEFAULT_MIN_FREE_DISK_BYTES = 5 * 1024 ** 3;
  static readonly DEFAULT_INTERVAL_MS = 2 * 60_000;

  readonly completedRetentionMs: number;
  readonly terminalRetentionMs: number;
  readonly retentionWindowMs: number;
  readonly minFreeDiskBytes: number;
  readonly intervalMs: number;

  constructor(overrides: WorkspaceRetentionConfigOverrides = {}) {
    this.completedRetentionMs = overrides.completedRetentionMs ?? overrides.retentionWindowMs ?? WorkspaceRetentionConfig.DEFAULT_COMPLETED_RETENTION_MS;
    this.terminalRetentionMs = overrides.terminalRetentionMs ?? overrides.retentionWindowMs ?? WorkspaceRetentionConfig.DEFAULT_TERMINAL_RETENTION_MS;
    this.retentionWindowMs = this.terminalRetentionMs;
    this.minFreeDiskBytes = overrides.minFreeDiskBytes ?? WorkspaceRetentionConfig.DEFAULT_MIN_FREE_DISK_BYTES;
    this.intervalMs = overrides.intervalMs ?? WorkspaceRetentionConfig.DEFAULT_INTERVAL_MS;
  }
}
