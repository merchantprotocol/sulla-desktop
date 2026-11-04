// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Marketplace/installable projections remain implemented, but are not part of personal sync. */
export async function syncRuntimeProjections(_force = false): Promise<void> { return; }

/** Runtime projection sync is retired from personal cloud sync; this is an honest no-op, not a disguised timer. */
class DisabledRuntimeProjectionSync {
  start(): void {}
  stop(): void {}
  changed(): void {}
}

export const CloudRuntimeProjectionSync = new DisabledRuntimeProjectionSync();
