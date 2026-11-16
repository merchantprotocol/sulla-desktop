// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * browserTabPreload.ts
 *
 * Electron preload script for WebContentsView-based browser tabs.
 *
 * Runs at document-start in the renderer process of each browser tab's
 * WebContentsView. Since contextIsolation is false, this script can
 * directly set globals on `window` before any page JavaScript executes.
 *
 * Responsibilities:
 *   1. Expose `window.__sullaBridgeEmit` so the guest bridge script
 *      (injected at DOMContentLoaded) can send events to the main
 *      process via `ipcRenderer.send()` instead of the iframe-era
 *      `window.parent.postMessage()` or webview-era
 *      `ipcRenderer.sendToHost()`.
 *   2. Inject the guest bridge script at document-start (through
 *      webFrame, so CSP-strict pages accept it) so `window.sullaBridge`
 *      is available as early as possible.
 *
 * This file must be compiled to JS and referenced as the `preload`
 * option when creating the browser tab's WebContentsView session.
 */

import { ipcRenderer, webFrame } from 'electron';

import { buildGuestBridgeScript } from '../agent/scripts/injected/GuestBridgePreload';
import { GuestBridgeInjector } from './guestBridgeInjector';
import { shouldFallbackToRootScroll } from './browserScrollFallback';
import { DEFAULT_THEME_ID } from '../config/theme';

const IPC_CHANNEL = 'browser-tab-view:bridge-event';
const LOG_PREFIX = '[SULLA_TAB_PRELOAD]';
const ROOT_SCROLL_FALLBACK_DELAY_MS = 80;

/* ------------------------------------------------------------------ */
/*  Native scroll-input health                                        */
/* ------------------------------------------------------------------ */

/**
 * A wedged WebContentsView can still dispatch trusted wheel events into the
 * page while Chromium's compositor refuses to apply them. Report only wheel
 * gestures that had somewhere to scroll; the main process uses consecutive
 * failures as an input-routing watchdog.
 */
window.addEventListener('wheel', (event) => {
  if (!event.isTrusted || event.ctrlKey || event.metaKey || Math.abs(event.deltaY) < 1) return;

  const direction = Math.sign(event.deltaY);
  let candidate = event.target instanceof Element ? event.target : null;
  let scrollTarget: Element | null = null;

  while (candidate) {
    const style = getComputedStyle(candidate);
    const canOverflow = /^(auto|scroll|overlay)$/.test(style.overflowY);
    const maxScrollTop = candidate.scrollHeight - candidate.clientHeight;
    const canMove = direction > 0
      ? candidate.scrollTop < maxScrollTop - 1
      : candidate.scrollTop > 1;

    if (canOverflow && maxScrollTop > 1 && canMove) {
      scrollTarget = candidate;
      break;
    }
    candidate = candidate.parentElement;
  }

  if (!scrollTarget) {
    const root = document.scrollingElement;
    const maxScrollTop = root ? root.scrollHeight - root.clientHeight : 0;
    const canMove = !!root && (direction > 0 ? root.scrollTop < maxScrollTop - 1 : root.scrollTop > 1);

    if (canMove) scrollTarget = root;
  }

  if (!scrollTarget) return;

  const before = scrollTarget.scrollTop;

  requestAnimationFrame(() => setTimeout(() => {
    const root = document.scrollingElement;
    const rootMaxScrollTop = root ? root.scrollHeight - root.clientHeight : 0;
    const nativeRootMoved = root && Math.abs(root.scrollTop - before) > 0.5;

    // WebContentsView can deliver trusted wheel events while Chromium's root
    // scroll node fails to consume them. Replay only that narrow case. Inner
    // overflow containers are left entirely to Chromium because they already
    // scroll correctly and should not cause the document to move as well.
    if (root && scrollTarget === root && !nativeRootMoved && shouldFallbackToRootScroll({
      hasInnerScrollableTarget: false,
      rootScrollTop:           root.scrollTop,
      rootMaxScrollTop,
      deltaY:                  event.deltaY,
      defaultPrevented:        event.defaultPrevented,
    })) {
      try {
        window.scrollBy({ top: event.deltaY, left: event.deltaX, behavior: 'instant' });
      } catch {
        window.scrollBy(event.deltaX, event.deltaY);
      }
    }

    try {
      ipcRenderer.send(IPC_CHANNEL, {
        type: 'sulla:view-scroll-heartbeat',
        data: { moved: Math.abs(scrollTarget.scrollTop - before) > 0.5 },
      });
    } catch (err) {
      console.error(`${ LOG_PREFIX } scroll heartbeat failed`, err);
    }
  }, ROOT_SCROLL_FALLBACK_DELAY_MS));
}, { capture: true, passive: true });

/* ------------------------------------------------------------------ */
/*  Web push stub                                                     */
/* ------------------------------------------------------------------ */
//
// Electron's Chromium ships without an FCM/GCM push service, so any
// website that calls `registration.pushManager.subscribe(...)` gets a
// cryptic "Registration failed - push service not available" rejection.
// Most sites surface that as a generic alert ("Couldn't enable
// notifications…"), which is noise — the user can't grant something the
// runtime physically doesn't support.
//
// Replace subscribe() with a NotAllowedError rejection — the same shape
// the API throws when the user denies permission, which sites already
// handle quietly. We intentionally do NOT touch `Notification.permission`
// or the `Notification` constructor: native OS toasts via `new
// Notification(...)` still work in Electron and we don't want to block
// them.

try {
  if (typeof PushManager !== 'undefined' && PushManager.prototype) {
    const deny = function(): Promise<never> {
      return Promise.reject(
        new DOMException('Push notifications are not available in this app.', 'NotAllowedError'),
      );
    };
    PushManager.prototype.subscribe = deny as typeof PushManager.prototype.subscribe;
  }
} catch (err) {
  console.warn(`${ LOG_PREFIX } web push stub failed`, err);
}

/* ------------------------------------------------------------------ */
/*  Theme bridge: sync Sulla Desktop theme → file:// page classes     */
/* ------------------------------------------------------------------ */

// Only inject theme classes into local file:// pages (agent-created HTML docs).
// Injecting on external URLs is harmless but unnecessary.
const IS_FILE_URL = location.protocol === 'file:';

function applyThemeToPage(theme: string): void {
  if (!IS_FILE_URL) return;
  const root = document.documentElement;
  const isLight = typeof theme === 'string' && theme.includes('-light');
  [...root.classList].filter(name => name.startsWith('theme-')).forEach(name => root.classList.remove(name));
  root.classList.remove('dark', 'light');
  root.classList.add(isLight ? 'light' : 'dark', `theme-${ theme }`);
}

// Apply on load — async IPC call, resolves before first meaningful paint
ipcRenderer.invoke('sulla-settings-get', 'theme', DEFAULT_THEME_ID)
  .then((theme: unknown) => applyThemeToPage(String(theme || DEFAULT_THEME_ID)))
  .catch(() => IS_FILE_URL && document.documentElement.classList.add('dark'));

// Listen for live theme changes pushed from the main process
ipcRenderer.on('sulla:theme-changed', (_event, theme: string) => {
  applyThemeToPage(theme);
});

/* ------------------------------------------------------------------ */
/*  1. Set up the bridge emit function BEFORE any page JS runs        */
/* ------------------------------------------------------------------ */

/**
 * The guest bridge's `emitToHost()` checks for this global first.
 * It provides a direct IPC path to the main process — no postMessage
 * or sendToHost indirection needed.
 */
(window as any).__sullaBridgeEmit = (type: string, data: unknown): void => {
  try {
    ipcRenderer.send(IPC_CHANNEL, { type, data });
  } catch (err) {
    console.error(`${ LOG_PREFIX } __sullaBridgeEmit failed`, { type, err });
  }
};

/* ------------------------------------------------------------------ */
/*  2. Inject the guest bridge IMMEDIATELY at document-start          */
/* ------------------------------------------------------------------ */
//
// Do NOT wait for DOMContentLoaded. The preload runs before any page
// JavaScript, which means:
//   • window, document, and document.documentElement are all defined
//   • document.body may be null (but our top-level handlers only reference
//     it inside function bodies that are called after the DOM is ready)
//   • the guest bridge's event listeners must be attached *before* any
//     page script runs, or we miss the early events
//
// On slow pages like Google Maps, DOMContentLoaded can fire 5-10s after
// navigation because of blocking script parsing. Waiting for it meant
// `window.__sulla` and `window.sullaBridge` were undefined during that
// window — which is exactly when tools like `browser/snapshot` tried to
// call them, timed out, and the agent retried (spawning yet more tabs).
//
// Inject through webFrame.executeJavaScript, not eval. With contextIsolation
// off the preload shares the page's main world, so `(0, eval)(script)` is
// checked against the page's Content-Security-Policy and is refused on any
// site without 'unsafe-eval' (GitHub, sulladesktop.com, most banks). Scripts
// the embedder executes through webFrame are not page eval and are not subject
// to script-src, the same reason the main process's executeJavaScript calls
// (context menu, vault autofill) work on those sites. All DOM mutations
// inside the script are guarded behind function invocations or
// DOMContentLoaded handlers they themselves register.

new GuestBridgeInjector(
  script => webFrame.executeJavaScript(script),
  console,
  LOG_PREFIX,
).inject(buildGuestBridgeScript(), location.href);
