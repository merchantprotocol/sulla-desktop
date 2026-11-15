// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref, type Ref } from 'vue';

/**
 * Where the message box and thread activity live: docked at the bottom of the
 * chat, or in the right-hand column with the chat's tabs. One choice for every
 * chat, kept across restarts. A window preference only; nothing in Sulla's
 * behaviour depends on it.
 */
export type DockPosition = 'bottom' | 'side';

export const DOCK_POSITION_KEY = 'sulla.chat.dockPosition';
export const SIDE_RATIO_KEY = 'sulla.chat.sideDockRatio';

/** The side column's share of the chat area's width. The CSS also keeps it between 340px and 70%. */
export const SIDE_RATIO_DEFAULT = 0.32;
export const SIDE_RATIO_MIN = 0.18;
export const SIDE_RATIO_MAX = 0.7;

export function clampSideRatio(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(SIDE_RATIO_MAX, Math.max(SIDE_RATIO_MIN, ratio)) : SIDE_RATIO_DEFAULT;
}

function readRatio(): number {
  try {
    const stored = localStorage.getItem(SIDE_RATIO_KEY);
    return stored === null ? SIDE_RATIO_DEFAULT : clampSideRatio(Number(stored));
  } catch { return SIDE_RATIO_DEFAULT }
}

function read(): DockPosition {
  try { return localStorage.getItem(DOCK_POSITION_KEY) === 'side' ? 'side' : 'bottom' } catch { return 'bottom' }
}

let shared: Ref<DockPosition> | null = null;
let sharedRatio: Ref<number> | null = null;

/** The shared position; every chat tab in this window sees the same value. */
export function useDockPosition(): {
  position:     Ref<DockPosition>;
  setPosition:  (next: DockPosition) => void;
  /** The side column's width as a share of the chat area, kept across restarts. */
  sideRatio:    Ref<number>;
  setSideRatio: (ratio: number, persist?: boolean) => void;
} {
  if (!shared || !sharedRatio) {
    shared = ref(read());
    sharedRatio = ref(readRatio());
    // Another window changed it.
    try {
      window.addEventListener('storage', (event) => {
        if (event.key === DOCK_POSITION_KEY && shared) shared.value = read();
        if (event.key === SIDE_RATIO_KEY && sharedRatio) sharedRatio.value = readRatio();
      });
    } catch { /* no window in tests */ }
  }
  const position = shared;
  const sideRatio = sharedRatio;
  return {
    sideRatio,
    /** Live while dragging; `persist` saves it (on release) so a drag does not write on every move. */
    setSideRatio(ratio, persist = true) {
      sideRatio.value = clampSideRatio(ratio);
      if (persist) {
        try { localStorage.setItem(SIDE_RATIO_KEY, String(Math.round(sideRatio.value * 1000) / 1000)) } catch { /* a convenience */ }
      }
    },
    position,
    setPosition(next) {
      position.value = next;
      try { localStorage.setItem(DOCK_POSITION_KEY, next) } catch { /* a convenience; the choice still applies this session */ }
    },
  };
}

/** Tests only: forget the shared value. */
export function resetDockPositionForTests(): void { shared = null; sharedRatio = null }
