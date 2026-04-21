// safeSend.ts — Crash-proof wrapper around webContents.send.
//
// Electron's `webContents.send` throws when the underlying render frame has
// been disposed — a race that happens during renderer crash, reload, or tab
// teardown. The webContents object's `isDestroyed()` returns false in this
// window (the object is alive), but the frame is gone, producing:
//
//   Error: Render frame was disposed before WebFrameMain could be accessed
//
// These log-flood main console and hide real errors. Any IPC message to a
// gone renderer is safe to drop — there's nothing to deliver it to. Callers
// that need delivery confirmation should use invoke() instead.

import type { WebContents } from 'electron';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

let warnedOnce = false;

/**
 * Send a message to a renderer, silently swallowing the "frame disposed"
 * race that is safe to ignore. Returns true if the send was attempted
 * (regardless of outcome), false if the target was clearly gone.
 *
 * Warns once on the first unexpected error so regressions don't go silent.
 */
export function safeSend(wc: WebContents | null | undefined, channel: string, ...args: unknown[]): boolean {
  if (!wc) return false;
  try {
    if (wc.isDestroyed()) return false;
  } catch {
    return false;
  }
  try {
    wc.send(channel, ...args);
    return true;
  } catch (err) {
    const message = (err as Error)?.message || String(err);
    // The frame-disposed race is expected during teardown. Ignore it silently.
    if (message.includes('Render frame was disposed') || message.includes('WebFrameMain')) {
      return false;
    }
    // Anything else is worth seeing (once) — schema mismatch, serialization
    // failure, etc.
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(`[safeSend] unexpected send error on channel="${ channel }":`, err);
    }
    return false;
  }
}
