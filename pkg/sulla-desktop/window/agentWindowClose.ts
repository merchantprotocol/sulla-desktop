// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.

export interface AgentWindowClosedContext {
  /** The window closed itself because its last tab closed. Closing it never quits the app. */
  closingViaLastTab: boolean;
  /** Agent windows still open, not counting the one that just closed. */
  remainingAgentWindows: number;
  /** application.window.quitOnClose setting. */
  quitOnClose: boolean;
}

/**
 * Decides whether closing an agent window should quit the app.
 * Only a plain close of the last agent window quits, and only when quitOnClose is on.
 */
export function shouldQuitOnAgentWindowClosed({ closingViaLastTab, remainingAgentWindows, quitOnClose }: AgentWindowClosedContext): boolean {
  if (closingViaLastTab) return false;
  if (remainingAgentWindows > 0) return false;
  return quitOnClose;
}
