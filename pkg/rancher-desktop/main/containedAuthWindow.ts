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

function lockDownSession(partition: string, logPrefix: string): Electron.Session {
  const sess = electronSession.fromPartition(partition);
  if (!lockedPartitions.has(partition)) {
    lockedPartitions.add(partition);
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

function contain(win: BrowserWindow, partition: string, logPrefix: string): void {
  const wc = win.webContents;
  const block = (event: Electron.Event, u: string) => {
    if (!isWebUrl(u)) {
      event.preventDefault();
      console.log(`${ logPrefix } Blocked hand-off to another app: ${ scheme(u) }`);
    }
  };
  wc.on('will-navigate', block);
  wc.on('will-redirect', block);
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
  wc.on('did-create-window', child => contain(child, partition, logPrefix));
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
  contain(win, opts.partition, opts.logPrefix);
  return win;
}
