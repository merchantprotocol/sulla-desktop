// ipcGuestGuard.ts — keep web content out of Sulla's privileged IPC.
//
// Every ipcMain channel (vault:*, chrome-api:cookies:*, browser-tab-view:exec-js,
// sulla-settings-get, …) was reachable by any renderer that could get hold of
// an ipcRenderer. Browser-tab guests run arbitrary websites with
// contextIsolation OFF, so the page shares a JS world with a preload that holds
// ipcRenderer — one prototype-pollution trick away from calling any of them.
//
// This module patches Electron's ipcMain once, before any handler is
// registered, so every listener/handler first checks the sender: requests from
// the browser-tab session (tabs, their popups, hidden agent browsers) are
// rejected unless the channel is on a tiny allowlist the tab preload actually
// uses. Sulla's own windows (default session) are unaffected.
//
// Import this module FIRST in background.ts: ES imports execute in order and
// several modules register handlers as an import side effect.

import Electron from 'electron';

import { BROWSER_SESSION_PARTITION } from './browserTabs/browserSession';

type AnyListener = (event: any, ...args: any[]) => any;

/**
 * Channels a browser-tab guest may use, with an argument check. Everything the
 * tab preload (browserTabPreload.ts) sends or invokes must be listed here.
 */
export const GUEST_ALLOWED_CHANNELS: Record<string, (args: unknown[]) => boolean> = {
  // Theme only — the handler returns ANY setting, including stored API keys.
  'sulla-settings-get':            args => args[0] === 'theme',
  // Bridge events (vault, context menu, scroll heartbeat). The per-tab
  // webContents.ipc handlers validate origin and context themselves.
  'browser-tab-view:bridge-event': () => true,
};

let browserSession: Electron.Session | null = null;

function getBrowserSessionSafe(): Electron.Session | null {
  if (browserSession) return browserSession;
  try {
    browserSession = Electron.session.fromPartition(BROWSER_SESSION_PARTITION);
  } catch {
    return null; // app not ready yet — no guest can exist before ready
  }

  return browserSession;
}

/** True when an IPC event came from web content in the browser-tab session. */
export function isBrowserGuestSender(event: any): boolean {
  const sender = event?.sender;
  if (!sender?.session) return false;
  const guestSession = getBrowserSessionSafe();

  return !!guestSession && sender.session === guestSession;
}

/** Whether `channel` with `args` may be delivered from `event`'s sender. */
export function isIpcAllowed(event: any, channel: string, args: unknown[]): boolean {
  if (!isBrowserGuestSender(event)) return true;
  const check = GUEST_ALLOWED_CHANNELS[channel];

  return !!check && check(args);
}

const reported = new Set<string>();

function reportBlocked(channel: string, event: any): void {
  if (reported.has(channel)) return;
  reported.add(channel);
  let origin = '(unknown)';
  try {
    origin = event?.senderFrame?.origin || new URL(event?.sender?.getURL?.() ?? '').origin;
  } catch { /* keep unknown */ }
  console.warn(`[ipcGuestGuard] blocked web content (${ origin }) from IPC channel "${ channel }"`);
}

let installed = false;

/**
 * Wrap Electron's ipcMain registration methods with the guest check. Idempotent.
 * Wrappers are tracked so removeListener/off with the original listener still
 * works (IpcMainProxy relies on that).
 */
export function installIpcGuestGuard(ipcMain: Electron.IpcMain = Electron.ipcMain): void {
  if (installed) return;
  installed = true;

  // listener → channel → wrapper (one listener may serve several channels).
  const wrappers = new WeakMap<AnyListener, Map<string, AnyListener>>();
  const target = ipcMain as any;

  const wrapListener = (channel: string, listener: AnyListener): AnyListener => {
    const byChannel = wrappers.get(listener) ?? new Map<string, AnyListener>();
    const existing = byChannel.get(channel);
    if (existing) return existing;
    const wrapped: AnyListener = function(this: unknown, event, ...args) {
      if (!isIpcAllowed(event, channel, args)) {
        reportBlocked(channel, event);

        return;
      }

      return listener.call(this, event, ...args);
    };
    byChannel.set(channel, wrapped);
    wrappers.set(listener, byChannel);

    return wrapped;
  };

  for (const method of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
    if (typeof target[method] !== 'function') continue;
    const original = target[method].bind(ipcMain);
    target[method] = (channel: string, listener: AnyListener) => original(channel, wrapListener(channel, listener));
  }
  for (const method of ['removeListener', 'off']) {
    if (typeof target[method] !== 'function') continue;
    const original = target[method].bind(ipcMain);
    target[method] = (channel: string, listener: AnyListener) => original(channel, wrappers.get(listener)?.get(channel) ?? listener);
  }
  for (const method of ['handle', 'handleOnce']) {
    if (typeof target[method] !== 'function') continue;
    const original = target[method].bind(ipcMain);
    target[method] = (channel: string, handler: AnyListener) => original(channel, function(this: unknown, event: any, ...args: any[]) {
      if (!isIpcAllowed(event, channel, args)) {
        reportBlocked(channel, event);
        throw new Error(`IPC channel "${ channel }" is not available to web content`);
      }

      return handler.call(this, event, ...args);
    });
  }
}

installIpcGuestGuard();
