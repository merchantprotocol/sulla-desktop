// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Pick the tab that takes over when the active tab disappears.
 *
 * Rule (Chrome-style): the next open tab after the removed one, else the
 * nearest open tab before it, else the first open tab. Returns null when
 * nothing remains, so the caller can open a fresh chat tab.
 *
 * @param orderedIds  Visual tab order captured BEFORE the removal.
 * @param removedId   The id that was removed (or is missing from the list).
 * @param remainingIds Ids still open after the removal.
 */
export function selectTabAfterRemoval(
  orderedIds: readonly string[],
  removedId: string,
  remainingIds: readonly string[],
): string | null {
  if (remainingIds.length === 0) return null;

  const open = new Set(remainingIds);
  const idx = orderedIds.indexOf(removedId);

  if (idx !== -1) {
    for (let i = idx + 1; i < orderedIds.length; i++) {
      if (open.has(orderedIds[i])) return orderedIds[i];
    }
    for (let i = idx - 1; i >= 0; i--) {
      if (open.has(orderedIds[i])) return orderedIds[i];
    }
  }

  return orderedIds.find(id => open.has(id)) ?? remainingIds[0];
}
