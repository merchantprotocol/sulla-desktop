// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Unsaved edits on Preferences → AI models outlive the page: switching to another settings page and
 * back keeps them, as long as the saved routing they were made against hasn't changed meanwhile.
 */
export interface KeptDraft<L, N> { base: string; lanes: L; never: N }

/** Holds at most one kept draft for the page; one shared instance lives as long as the window. */
export class LedgerDrafts {
  static readonly shared = new LedgerDrafts();
  private kept: KeptDraft<unknown, unknown> | null = null;

  keep<L, N>(draft: KeptDraft<L, N>): void { this.kept = draft }

  /** The kept draft when it was made against `base`; taking it clears it either way. */
  take<L, N>(base: string): KeptDraft<L, N> | null {
    const found = this.kept?.base === base ? this.kept as KeptDraft<L, N> : null;
    this.kept = null;
    return found;
  }

  /** Forget any kept draft (after a save, and between tests). */
  clear(): void { this.kept = null }
}
