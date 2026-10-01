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

let lastChromeActionAt = 0;
let listening = 0;

function noteChromeAction(): void {
  lastChromeActionAt = Date.now();
}

// Plain typing must not count — the human is typing when focus gets stolen.
// Only keys that submit, move focus or fire shortcuts explain a blur.
function noteChromeKey(e: KeyboardEvent): void {
  if (e.key === 'Tab' || e.key === 'Escape' || e.key === 'Enter' || e.metaKey || e.ctrlKey || e.altKey) noteChromeAction();
}

function isShown(el: HTMLElement): boolean {
  if (!el.isConnected || el.getClientRects().length === 0) return false;

  return getComputedStyle(el).visibility !== 'hidden';
}

export function useFocusGuard(elRef: Ref<HTMLElement | null>): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let guarded: HTMLElement | null = null;

  function onBlur(): void {
    if (Date.now() - lastChromeActionAt < HUMAN_ACTION_MS) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(reclaim, RECLAIM_DELAY_MS);
  }

  async function reclaim(): Promise<void> {
    timer = null;
    const el = elRef.value;
    if (!el || !isShown(el)) return;
    if (Date.now() - lastChromeActionAt < HUMAN_ACTION_MS + RECLAIM_DELAY_MS) return;
    // Focus already landed on another field inside the chrome on purpose.
    const active = document.activeElement;
    if (active && active !== document.body && active !== el) return;

    let allowed = false;
    try {
      allowed = await ipcRenderer.invoke('browser-tab-view:reclaim-chrome-focus');
    } catch {
      return;
    }
    if (!allowed || !isShown(el) || Date.now() - lastChromeActionAt < HUMAN_ACTION_MS) return;
    const nowActive = document.activeElement;
    if (nowActive && nowActive !== document.body && nowActive !== el) return;
    el.focus({ preventScroll: true });
  }

  onMounted(() => {
    if (listening++ === 0) {
      window.addEventListener('pointerdown', noteChromeAction, true);
      window.addEventListener('keydown', noteChromeKey, true);
    }
    guarded = elRef.value;
    guarded?.addEventListener('blur', onBlur);
  });

  onUnmounted(() => {
    if (timer) clearTimeout(timer);
    guarded?.removeEventListener('blur', onBlur);
    if (--listening === 0) {
      window.removeEventListener('pointerdown', noteChromeAction, true);
      window.removeEventListener('keydown', noteChromeKey, true);
    }
  });
}
