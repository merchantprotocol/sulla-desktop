// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Test-process registry linking a Desktop request id to its monotonic vault-arrival time. */
export class RequestTimingRegistry {
  private static readonly maxEntries = 10_000;
  private readonly receivedAtNs = new Map<string, string>();

  recordRequestReceived(requestId: string): void {
    if (this.receivedAtNs.size >= RequestTimingRegistry.maxEntries) {
      const oldest = this.receivedAtNs.keys().next().value as string | undefined;
      if (oldest) this.receivedAtNs.delete(oldest);
    }
    this.receivedAtNs.set(requestId, process.hrtime.bigint().toString());
  }

  snapshot(): Record<string, string> { return Object.fromEntries(this.receivedAtNs); }

  reset(): void { this.receivedAtNs.clear(); }
}
