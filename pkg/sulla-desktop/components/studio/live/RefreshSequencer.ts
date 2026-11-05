// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export class RefreshSequencer {
  private latestRequested = 0;
  private latestApplied = 0;

  next(): number {
    this.latestRequested += 1;
    return this.latestRequested;
  }

  tryApply(ticket: number): boolean {
    if (ticket <= this.latestApplied) return false;
    this.latestApplied = ticket;
    return true;
  }

  hasAppliedNewerThan(ticket: number): boolean {
    return this.latestApplied > ticket;
  }
}
