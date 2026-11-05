// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export class RefreshSequencer {
  private latestRequested = 0;

  next(): number {
    this.latestRequested += 1;
    return this.latestRequested;
  }

  isLatest(ticket: number): boolean {
    return ticket === this.latestRequested;
  }
}
