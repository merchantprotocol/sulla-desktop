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
 *   2. Listen for messages from the main process and forward them
 *      to the guest bridge if needed.
 *   3. Inject the guest bridge script at DOMContentLoaded so
 *      `window.sullaBridge` is available as early as possible.
 *
 * This file must be compiled to JS and referenced as the `preload`
 * option when creating the browser tab's WebContentsView session.
 */

import { ipcRenderer } from 'electron';

import { buildGuestBridgeScript } from '../agent/scripts/injected/GuestBridgePreload';

const IPC_CHANNEL = 'browser-tab-view:bridge-event';
const LOG_PREFIX = '[SULLA_TAB_PRELOAD]';

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
    const deny = function (): Promise<never> {
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
  root.classList.remove('dark', 'light');
  root.classList.add(isLight ? 'light' : 'dark');
}

// Apply on load — async IPC call, resolves before first meaningful paint
ipcRenderer.invoke('sulla-settings-get', 'theme', 'protocol-dark')
  .then((theme: unknown) => applyThemeToPage(String(theme || 'protocol-dark')))
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
/*  2. Listen for commands from the main process                      */
/* ------------------------------------------------------------------ */

ipcRenderer.on('browser-tab-view:execute', (_event, code: string) => {
  try {
    // eslint-disable-next-line no-eval
    (0, eval)(code);
  } catch (err) {
    console.error(`${ LOG_PREFIX } execute failed`, { code: code.slice(0, 200), err });
  }
});

/* ------------------------------------------------------------------ */
/*  3. Inject the guest bridge IMMEDIATELY at document-start          */
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
// Eval synchronously here. All DOM mutations (appendChild to body, etc.)
// inside the script are guarded behind function invocations or
// DOMContentLoaded handlers they themselves register.

function injectGuestBridge(): void {
  try {
    const script = buildGuestBridgeScript();
    // eslint-disable-next-line no-eval
    (0, eval)(script);
    console.log(`${ LOG_PREFIX } guest bridge injected`, { url: location.href, readyState: document.readyState });
  } catch (err) {
    console.error(`${ LOG_PREFIX } guest bridge injection failed`, err);
  }
}

injectGuestBridge();
