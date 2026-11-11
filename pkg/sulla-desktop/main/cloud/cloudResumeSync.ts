// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { CloudPreferences } from './cloudSettings';

export interface ResumableFilesDriver {
  resetBackoff(): void;
  wake(): void;
}

export interface ResumableVaultDriver {
  syncNow(): Promise<unknown>;
}

export interface CloudResumeSyncDeps {
  files: ResumableFilesDriver;
  vault: ResumableVaultDriver;
  preferences: () => Promise<Pick<CloudPreferences, 'enabled' | 'vault'>>;
  isSignedIn: () => boolean;
}

/** Network is back or the laptop woke: Files retries now, Vault pushes local edits that waited while offline. */
export class CloudResumeSync {
  constructor(private readonly deps: CloudResumeSyncDeps) {}

  async handleOnline(): Promise<void> {
    if (!this.deps.isSignedIn()) return;
    const prefs = await this.deps.preferences();
    if (!prefs.enabled) return;
    this.deps.files.resetBackoff();
    this.deps.files.wake();
    if (prefs.vault) await this.deps.vault.syncNow();
  }
}
