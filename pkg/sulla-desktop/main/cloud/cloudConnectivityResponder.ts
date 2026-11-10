// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** A sync driver that can drop its backoff and push pending work once the network is back. */
export interface ResumableSyncDriver {
  resumeAfterOffline(): void;
}

export interface CloudConnectivityDrivers {
  files: ResumableSyncDriver;
  vault: ResumableSyncDriver;
}

/** Reacts to 'online': Files retries now, Vault pushes local edits that waited while offline. */
export class CloudConnectivityResponder {
  constructor(private readonly drivers: CloudConnectivityDrivers) {}

  handleOnline(): void {
    this.drivers.files.resumeAfterOffline();
    this.drivers.vault.resumeAfterOffline();
  }
}
