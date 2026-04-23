/**
 * Deep-link handler for the `sulla://` custom URL scheme.
 *
 * Flow:
 *   1. electron-builder registers `sulla` in Info.plist (macOS) and the
 *      per-user registry (Windows) at install time. On Linux we also
 *      call app.setAsDefaultProtocolClient('sulla') at runtime.
 *   2. The OS launches (or focuses) Sulla Desktop and delivers the URL:
 *        - macOS: via the 'open-url' app event (no argv on cold launch).
 *        - Linux/Windows: appended to process.argv on cold launch, or
 *          delivered through the 'second-instance' event when already
 *          running (see requestSingleInstanceLock).
 *   3. handleDeepLink() parses the URL and routes it to the main
 *      window. If the renderer hasn't mounted yet (cold launch) we
 *      poll briefly until a loaded BrowserWindow is available.
 *
 * Supported URLs:
 *   sulla://marketplace/install?id=<template-id>
 *     → opens (or focuses) the marketplace tab and auto-loads the
 *       detail view for the requested template.
 */

import { URL } from 'url';

import Electron from 'electron';

import Logging from '@pkg/utils/logging';
import * as window from '@pkg/window';

const console = Logging.background;

const SCHEME = 'sulla:';

// Cold-launch deep links arrive before the renderer mounts, so we
// retry dispatch for up to DISPATCH_TIMEOUT_MS before giving up.
const DISPATCH_TIMEOUT_MS = 20_000;
const DISPATCH_POLL_MS = 100;

export function isDeepLink(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === SCHEME;
  } catch {
    return false;
  }
}

/**
 * Pull any sulla:// URL out of a process.argv-style array. Returns the
 * first match (Electron only guarantees one deep link per launch).
 */
export function findDeepLinkInArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (isDeepLink(arg)) return arg;
  }
  return null;
}

export function handleDeepLink(rawUrl: string): void {
  if (!isDeepLink(rawUrl)) return;

  // On macOS, 'open-url' can fire before app.whenReady() resolves
  // (happens during cold-launch when the user clicks a sulla:// link
  // with no instance running). BrowserWindow construction requires a
  // ready app, so defer everything until then. whenReady() resolves
  // immediately when already ready, making this a no-op later.
  Electron.app.whenReady().then(() => {
    try {
      window.openMain();
    } catch (err) {
      console.error('[deep-link] openMain failed:', err);
    }
    void dispatchWhenReady(rawUrl);
  }).catch((err) => {
    console.error('[deep-link] whenReady rejected:', err);
  });
}

async function dispatchWhenReady(rawUrl: string): Promise<void> {
  const deadline = Date.now() + DISPATCH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const target = pickReadyWindow();
    if (target) {
      dispatch(target, rawUrl);
      return;
    }
    await delay(DISPATCH_POLL_MS);
  }

  console.warn('[deep-link] gave up waiting for a ready window:', rawUrl);
}

function pickReadyWindow(): Electron.BrowserWindow | null {
  // Prefer the main-agent window — it's the one that hosts the
  // marketplace tab and AgentRouter listeners. Other windows (dialogs,
  // prefs) can't handle our agent-command stream.
  const main = window.getWindow('main-agent');
  if (main && !main.isDestroyed() && !main.webContents.isLoading()) {
    return main;
  }
  return null;
}

function dispatch(target: Electron.BrowserWindow, rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    console.warn('[deep-link] malformed URL:', rawUrl, err);
    return;
  }

  // URL pattern for custom schemes is quirky: hostname holds the
  // first path segment (e.g. sulla://marketplace/install → host is
  // "marketplace", pathname is "/install").
  const section = parsed.hostname;
  const action = parsed.pathname.replace(/^\/+/, '');

  if (section === 'marketplace' && action === 'install') {
    const id = parsed.searchParams.get('id');
    if (!id) {
      console.warn('[deep-link] marketplace/install missing id param:', rawUrl);
      return;
    }
    target.focus();
    target.webContents.send('agent-command', {
      command:    'marketplace:open-detail',
      templateId: id,
    });
    console.log('[deep-link] dispatched marketplace:open-detail id=', id);
    return;
  }

  console.warn('[deep-link] unhandled URL:', rawUrl);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
