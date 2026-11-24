// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Owns trace disclosure state for one transcript instance. */
export class TraceDisclosureController {
  private readonly opened = new Set<string>();
  private allOpen = false;

  isOpen(id: string): boolean { return this.allOpen || this.opened.has(id); }
  toggle(id: string): void {
    if (this.isOpen(id)) { this.opened.delete(id); if (this.allOpen) this.allOpen = false; }
    else this.opened.add(id);
  }
  openAll(): void { this.allOpen = true; }
  closeAll(): void { this.allOpen = false; this.opened.clear(); }
  toggleAll(): void { this.allOpen ? this.closeAll() : this.openAll(); }
  get isAllOpen(): boolean { return this.allOpen; }
}
