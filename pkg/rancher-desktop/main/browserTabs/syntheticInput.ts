// syntheticInput.ts — Tells agent-driven input apart from the human's.
//
// webContents 'input-event' fires for synthesized events (sendInputEvent,
// CDP Input.dispatch*) exactly like real ones. Agent input paths stamp the
// target here right before dispatching, so listeners can ignore events that
// arrive inside that window instead of treating the agent as the human.

import type { WebContents } from 'electron';

const SYNTHETIC_WINDOW_MS = 500;
const lastSyntheticAt = new WeakMap<WebContents, number>();

export function markSyntheticInput(wc: WebContents): void {
  lastSyntheticAt.set(wc, Date.now());
}

export function isRecentSyntheticInput(wc: WebContents, now = Date.now()): boolean {
  return now - (lastSyntheticAt.get(wc) ?? 0) < SYNTHETIC_WINDOW_MS;
}
