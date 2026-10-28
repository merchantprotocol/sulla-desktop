// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BrowserWindow } from 'electron';

/** How long a hidden popup stays warm for a quick re-open. */
export const HIDDEN_WINDOW_GRACE_MS = 60_000;

/**
 * Destroy a reusable popup window once it has stayed hidden for `graceMs`.
 *
 * Popups that hide instead of closing keep a whole renderer process alive for
 * the rest of the session. This keeps the fast re-open while the user is
 * actively using the popup, then lets the renderer go. The owner must already
 * handle 'closed' (drop its reference) and recreate the window on next show.
 */
export function releaseWhenHidden(win: BrowserWindow, graceMs = HIDDEN_WINDOW_GRACE_MS): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  win.on('hide', () => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (!win.isDestroyed() && !win.isVisible()) win.destroy();
    }, graceMs);
    timer.unref?.();
  });
  win.on('show', clear);
  win.on('closed', clear);
}
