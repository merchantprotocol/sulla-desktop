// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// useFocusGuard — keep keyboard focus in a field the human is typing in.
//
// Agents open, load and drive browser tabs while the human types in the
// chrome (chat composer, address bar). Those native tab views can take
// keyboard focus away from the chrome renderer even though the human never
// touched them. When a guarded field blurs and the human did nothing in the
// chrome just before it, ask main whether focus was stolen; main refuses if
// the human really clicked/typed into a page or left the window.

import { onMounted, onUnmounted, type Ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

/** A human action in the chrome this recent explains the blur. */
const HUMAN_ACTION_MS = 400;
/** Give main time to see a real click land in a tab page first. */
const RECLAIM_DELAY_MS = 120;

type FocusIpc = Pick<typeof ipcRenderer, 'invoke'>;

/**
 * Window-wide record of the human's last action in the chrome, shared by
 * every guarded field so there is one pair of window listeners.
 */
export class ChromeActivity {
  private static instance: ChromeActivity | null = null;

  /** The single tracker every guarded field in this window shares. */
  static shared(): ChromeActivity {
    if (!ChromeActivity.instance) ChromeActivity.instance = new ChromeActivity(ipcRenderer);

    return ChromeActivity.instance;
  }

  private lastChromeActionAt = 0;
  private listening = 0;

  constructor(private readonly ipc: FocusIpc) {}

  /** Milliseconds since the human last did something in the chrome. */
  sinceLastAction(): number {
    return Date.now() - this.lastChromeActionAt;
  }

  /** Ask main whether the chrome may take focus back from a tab view. */
  reclaimChromeFocus(): Promise<boolean> {
    return this.ipc.invoke('browser-tab-view:reclaim-chrome-focus');
  }

  /** First guarded field installs the window listeners. */
  listen(): void {
    if (this.listening++ === 0) {
      window.addEventListener('pointerdown', this.noteChromeAction, true);
      window.addEventListener('keydown', this.noteChromeKey, true);
    }
  }

  /** Last guarded field removes the window listeners. */
  unlisten(): void {
    if (--this.listening === 0) {
      window.removeEventListener('pointerdown', this.noteChromeAction, true);
      window.removeEventListener('keydown', this.noteChromeKey, true);
    }
  }

  private readonly noteChromeAction = (): void => {
    this.lastChromeActionAt = Date.now();
  };

  // Plain typing must not count — the human is typing when focus gets stolen.
  // Only keys that submit, move focus or fire shortcuts explain a blur.
  private readonly noteChromeKey = (e: KeyboardEvent): void => {
    if (e.key === 'Tab' || e.key === 'Escape' || e.key === 'Enter' || e.metaKey || e.ctrlKey || e.altKey) this.noteChromeAction();
  };
}

function isShown(el: HTMLElement): boolean {
  if (!el.isConnected || el.getClientRects().length === 0) return false;

  return getComputedStyle(el).visibility !== 'hidden';
}

export function useFocusGuard(elRef: Ref<HTMLElement | null>): void {
  const activity = ChromeActivity.shared();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let guarded: HTMLElement | null = null;

  function onBlur(): void {
    if (activity.sinceLastAction() < HUMAN_ACTION_MS) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(reclaim, RECLAIM_DELAY_MS);
  }

  async function reclaim(): Promise<void> {
    timer = null;
    const el = elRef.value;
    if (!el || !isShown(el)) return;
    if (activity.sinceLastAction() < HUMAN_ACTION_MS + RECLAIM_DELAY_MS) return;
    // Focus already landed on another field inside the chrome on purpose.
    const active = document.activeElement;
    if (active && active !== document.body && active !== el) return;

    let allowed = false;
    try {
      allowed = await activity.reclaimChromeFocus();
    } catch {
      return;
    }
    if (!allowed || !isShown(el) || activity.sinceLastAction() < HUMAN_ACTION_MS) return;
    const nowActive = document.activeElement;
    if (nowActive && nowActive !== document.body && nowActive !== el) return;
    el.focus({ preventScroll: true });
  }

  onMounted(() => {
    activity.listen();
    guarded = elRef.value;
    guarded?.addEventListener('blur', onBlur);
  });

  onUnmounted(() => {
    if (timer) clearTimeout(timer);
    guarded?.removeEventListener('blur', onBlur);
    activity.unlisten();
  });
}
