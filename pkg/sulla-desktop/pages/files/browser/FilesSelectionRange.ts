// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The click rules of row selection: plain, Cmd/Ctrl toggle and Shift range (Finder/Explorer style). */
export class FilesSelectionRange {
  /**
   * The keys from the anchor to the target inclusive, in display order, or null when either is not displayed.
   */
  static between(orderedKeys:readonly string[], anchorKey:string, targetKey:string):string[] | null {
    const start = orderedKeys.indexOf(anchorKey); const end = orderedKeys.indexOf(targetKey);

    if (start < 0 || end < 0) return null;
    return orderedKeys.slice(Math.min(start, end), Math.max(start, end) + 1);
  }

  /** A Shift range replaces the selection, or adds to it when Cmd/Ctrl is also held. */
  static extend(existing:ReadonlySet<string>, range:readonly string[], additive:boolean):Set<string> {
    return new Set([...(additive ? existing : []), ...range]);
  }

  /** Cmd/Ctrl-click flips one key in or out of the selection. */
  static toggle(existing:ReadonlySet<string>, key:string):Set<string> {
    const next = new Set(existing);

    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }
}
