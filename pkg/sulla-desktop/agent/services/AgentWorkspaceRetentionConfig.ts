// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface WorkspaceRetentionConfigOverrides {
  retentionWindowMs?:  number;
  minFreeDiskBytes?:   number;
}

/**
 * Tuning for AgentWorkspaceRetentionPolicy. The retention window is the grace
 * period a safe (pushed, clean) git checkout gets before normal sweeps reclaim
 * it; minFreeDiskBytes is the same guest-disk floor used by the sibling
 * container-retention policy, so both policies start reclaiming at once.
 */
export class WorkspaceRetentionConfig {
  static readonly DEFAULT_RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
  static readonly DEFAULT_MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024;

  readonly retentionWindowMs: number;
  readonly minFreeDiskBytes:  number;

  constructor(overrides: WorkspaceRetentionConfigOverrides = {}) {
    this.retentionWindowMs = overrides.retentionWindowMs ?? WorkspaceRetentionConfig.DEFAULT_RETENTION_WINDOW_MS;
    this.minFreeDiskBytes  = overrides.minFreeDiskBytes ?? WorkspaceRetentionConfig.DEFAULT_MIN_FREE_DISK_BYTES;
  }
}
