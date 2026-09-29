/**
 * Sign-in windows that can't leak out of Sulla Desktop.
 *
 * Every embedded OAuth window (Claude, OpenAI, Sulla Cloud, generic
 * integrations) must finish its handshake back inside Sulla. Two things can
 * send it elsewhere:
 *
 *   1. App hand-offs. A session without a permission handler grants
 *      everything, including `openExternal`, so a provider page can hand a
 *      custom-scheme URL (claude://, …) to macOS. That once signed in the
 *      host's Claude desktop app instead of `claude setup-token` in the VM.
 *   2. Popups. `window.open` (Google/Apple SSO) would otherwise inherit no
 *      guards.
 *
 * Each window gets its own partition whose permission handler refuses
 * everything, blocks navigation to non-web schemes, and opens web popups as
 * child windows under the same rules.
 */

import { BrowserWindow, session as electronSession } from 'electron';

import Logging from '@pkg/utils/logging';

const console = Logging.background;

const lockedPartitions = new Set<string>();

/**
 * Electron's default user agent carries "Electron/x" and the app name. Sign-in
 * pages react to that: claude.ai bounced a signed-in user from its authorize
 * page straight to the app home (it's Electron, like the Claude desktop app),
 * and Google refuses embedded Electron sign-in outright. Present plain Chrome.
 */
export function plainChromeUserAgent(ua: string): string {
  return ua
    .replace(/\sElectron\/\S+/g, '')
    .replace(/\s[^\s/()]+(?:\s[^\s/()]+)*\/\d[\w.-]*(?=\sChrome\/)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function lockDownSession(partition: string, logPrefix: string): Electron.Session {
  const sess = electronSession.fromPartition(partition);
  if (!lockedPartitions.has(partition)) {
    lockedPartitions.add(partition);
    const ua = plainChromeUserAgent(sess.getUserAgent());
    sess.setUserAgent(ua);
    console.log(`${ logPrefix } Sign-in user agent: ${ ua }`);
    sess.setPermissionRequestHandler((_wc, permission, callback) => {
      console.log(`${ logPrefix } Denied permission request: ${ permission }`);
      callback(false);
    });
    sess.setPermissionCheckHandler(() => false);
  }
  return sess;
}

export function isWebUrl(u: string): boolean {
  try {
    const { protocol } = new URL(u);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function scheme(u: string): string {
  return `${ u.split(':')[0] }:`;
}

/** Origin + path only: query strings carry codes and state, never log them. */
function describeUrl(u: string): string {
  try {
    const { origin, pathname } = new URL(u);
    return `${ origin }${ pathname }`;
  } catch {
    return scheme(u);
  }
}

/**
 * Returns true when the URL is the provider's OAuth callback. Runs for the
 * sign-in window and every popup it opens: providers often finish sign-in in
 * a popup (Google SSO), and a parent-only listener never sees that callback.
 */
export type AuthCallbackHandler = (url: string) => boolean;

function contain(win: BrowserWindow, partition: string, logPrefix: string, onUrl?: AuthCallbackHandler): void {
  const wc = win.webContents;
  const block = (event: Electron.Event, u: string) => {
    if (!isWebUrl(u)) {
      event.preventDefault();
      console.log(`${ logPrefix } Blocked hand-off to another app: ${ scheme(u) }`);
      return;
    }
    // Callback caught: stop it from loading. Anything else listening on that
    // URL (a localhost login server on the host) must not see the code.
    if (onUrl?.(u)) event.preventDefault();
  };
  wc.on('will-navigate', block);
  wc.on('will-redirect', (event, u) => {
    console.log(`${ logPrefix } Sign-in window redirecting to ${ describeUrl(u) }`);
    block(event, u);
  });
  wc.on('did-navigate', (_event, u) => {
    console.log(`${ logPrefix } Sign-in window at ${ describeUrl(u) }`);
    onUrl?.(u);
  });
  wc.on('did-navigate-in-page', (_event, u) => {
    onUrl?.(u);
  });
  wc.on('will-frame-navigate', (details) => {
    if (!isWebUrl(details.url)) {
      details.preventDefault();
      console.log(`${ logPrefix } Blocked frame hand-off to another app: ${ scheme(details.url) }`);
    }
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (!isWebUrl(url)) {
      console.log(`${ logPrefix } Blocked popup to another app: ${ scheme(url) }`);
      return { action: 'deny' };
    }
    console.log(`${ logPrefix } Sign-in popup opened: ${ describeUrl(url) }`);
    if (onUrl?.(url)) return { action: 'deny' };
    return {
      action:                       'allow',
      overrideBrowserWindowOptions: {
        parent:          win,
        width:           600,
        height:          720,
        autoHideMenuBar: true,
        webPreferences:  {
          nodeIntegration:  false,
          contextIsolation: true,
          sandbox:          true,
          partition,
        },
      },
    };
  });
  wc.on('did-create-window', child => contain(child, partition, logPrefix, onUrl));
}

export interface ContainedAuthWindowOptions {
  title:            string;
  width:            number;
  height:           number;
  /** Session partition, e.g. 'persist:claude-oauth'. Keeps provider cookies apart from the app. */
  partition:        string;
  logPrefix:        string;
  resizable?:       boolean;
  autoHideMenuBar?: boolean;
  /** Spots the OAuth callback in this window or any popup. Return true when handled. */
  onUrl?:           AuthCallbackHandler;
}

export function createContainedAuthWindow(opts: ContainedAuthWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width:           opts.width,
    height:          opts.height,
    title:           opts.title,
    resizable:       opts.resizable ?? true,
    autoHideMenuBar: opts.autoHideMenuBar ?? true,
    webPreferences:  {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox:          true,
      session:          lockDownSession(opts.partition, opts.logPrefix),
    },
  });
  contain(win, opts.partition, opts.logPrefix, opts.onUrl);
  return win;
}
