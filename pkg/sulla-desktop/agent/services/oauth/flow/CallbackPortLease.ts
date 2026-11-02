// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export class CallbackPortInUseError extends Error {
  readonly code = 'port_in_use' as const;

  constructor(readonly port: number, readonly owner: string) {
    super(`OAuth callback port ${ port } is already leased by ${ owner }`);
    this.name = 'CallbackPortInUseError';
  }
}

/** Process-wide ownership for providers which require a fixed loopback port. */
export class CallbackPortLease {
  private static readonly owners = new Map<number, string>();
  private released = false;

  private constructor(readonly port: number, readonly owner: string) {}

  static acquire(port: number | undefined, owner: string): CallbackPortLease | null {
    if (!port) return null;
    const current = this.owners.get(port);
    if (current) throw new CallbackPortInUseError(port, current);
    this.owners.set(port, owner);
    return new CallbackPortLease(port, owner);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (CallbackPortLease.owners.get(this.port) === this.owner) {
      CallbackPortLease.owners.delete(this.port);
    }
  }
}
