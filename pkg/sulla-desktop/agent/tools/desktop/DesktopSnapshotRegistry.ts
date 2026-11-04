// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface SnapshotOwner { app: string; windowId?: string }

/** Session-scoped ownership registry for accessibility snapshot references. */
export class DesktopSnapshotRegistry {
  private readonly snapshots = new Map<string, SnapshotOwner>();

  remember(id: string, owner: SnapshotOwner): void { this.snapshots.set(id, { ...owner }); }
  lookup(id: string): SnapshotOwner | undefined {
    const owner = this.snapshots.get(id);
    return owner ? { ...owner } : undefined;
  }
  forget(id: string): void { this.snapshots.delete(id); }
  dispose(): void { this.snapshots.clear(); }
}
