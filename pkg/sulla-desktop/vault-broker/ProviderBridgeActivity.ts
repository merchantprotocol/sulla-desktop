// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Tracks provider-stream activity for the one agent container identified by pod id. */
export class ProviderBridgeActivity {
  private readonly lastActivityByPod = new Map<string, number>();

  mark(podId: string | undefined, at = Date.now()): void {
    if (!podId) return;
    this.lastActivityByPod.set(podId, at);
    // Container ids are unique; discard stale entries so long-lived hosts don't
    // accumulate ids from containers that have already exited.
    for (const [id, lastAt] of this.lastActivityByPod) {
      if (at - lastAt > 60 * 60_000) this.lastActivityByPod.delete(id);
    }
  }

  isActiveSince(podId: string | undefined, since: number): boolean {
    return this.lastActivityAt(podId) > since;
  }

  lastActivityAt(podId: string | undefined): number {
    return podId ? (this.lastActivityByPod.get(podId) ?? 0) : 0;
  }
}

export const providerBridgeActivity = new ProviderBridgeActivity();
