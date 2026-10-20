/**
 * Broadcast `computer-use:settings-changed` to every renderer window so
 * the Computer Use Settings page (and anything else listening) can
 * reactively refresh when an agent revokes app access.
 *
 * Agents can revoke access, but only the human can enable applications.
 */
export function broadcastComputerUseSettingsChanged(): void {
  try {
    // Lazy import to keep the agent-tools bundle lean — these modules
    // pull in electron at require-time.

    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send('computer-use:settings-changed'); } catch { /* ignore */ }
    }
  } catch { /* electron not available in this context — no-op */ }
}
