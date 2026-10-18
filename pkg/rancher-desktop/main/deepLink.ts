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
 *   sulla://packages/install?id=<template-id>  (also sulla://marketplace/…)
 *     → opens (or focuses) the Packages tab and auto-loads the
 *       detail view for the requested template.
 */

import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'url';

import Electron from 'electron';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getSullaFilesLinkService, type ShareMode } from '@pkg/main/sullaFilesLinkService';
import { getSullaFilesWatcher } from '@pkg/main/sullaFilesWatcher';
import Logging from '@pkg/utils/logging';
import * as window from '@pkg/window';

const console = Logging.background;

const SCHEME = 'sulla:';

// Cold-launch deep links arrive before the renderer mounts, so we
// retry dispatch for up to DISPATCH_TIMEOUT_MS before giving up.
const DISPATCH_TIMEOUT_MS = 20_000;
const DISPATCH_POLL_MS = 100;
const RESIDENCY_TRANSFER_TIMEOUT_MS = 30 * 60_000;

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
    dispatchWhenReady(rawUrl).catch(err => console.error('[deep-link] dispatch failed:', err));
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

  if (section === 'files' && ['copy-link', 'share', 'history', 'keep', 'online-only'].includes(action)) {
    handleFilesAction(target, action, parsed.searchParams.get('path') ?? '').catch(async(err) => {
      console.error('[deep-link] Files action failed:', err);
      await Electron.dialog.showMessageBox(target, {
        type:    'error',
        message: 'Sulla Files could not complete that action.',
        detail:  err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }

  // Use Cases is the current name; marketplace and packages stay working.
  if ((section === 'marketplace' || section === 'packages' || section === 'use-cases') && action === 'install') {
    const id = parsed.searchParams.get('id');
    if (!id) {
      console.warn(`[deep-link] ${ section }/install missing id param:`, rawUrl);
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

async function handleFilesAction(target:Electron.BrowserWindow, action:string, absolutePath:string):Promise<void> {
  const watcher = getSullaFilesWatcher();
  let root:string;
  try { root = await fs.promises.realpath(watcher.folder) } catch { await Electron.dialog.showMessageBox(target, { type: 'error', message: 'Sulla Files is unavailable.' }); return }
  const candidate = path.resolve(absolutePath);
  if (candidate !== root && !candidate.startsWith(`${ root }${ path.sep }`)) {
    await Electron.dialog.showMessageBox(target, { type: 'error', message: 'That item is outside Sulla Files.' }); return;
  }
  let resolved = candidate;
  let info:fs.Stats | undefined;
  try {
    resolved = await fs.promises.realpath(candidate);
    if (resolved !== root && !resolved.startsWith(`${ root }${ path.sep }`)) {
      await Electron.dialog.showMessageBox(target, { type: 'error', message: 'That item resolves outside Sulla Files.' }); return;
    }
    info = await fs.promises.stat(resolved);
  } catch {
    if (action !== 'keep') { await Electron.dialog.showMessageBox(target, { type: 'error', message: 'That Sulla Files item is unavailable.' }); return }
  }
  const relativePath = path.relative(root, resolved).split(path.sep).join('/');
  if (info?.isDirectory()) {
    if (action === 'history' || action === 'copy-link') {
      await Electron.dialog.showMessageBox(target, { type: 'info', message: action === 'history' ? 'Version history is available for files, not folders.' : 'Copy link is available for files. Use Share with people… to review folder sharing.' }); return;
    }
    target.focus();
    target.webContents.send('agent-command', { command: 'open-tab', mode: 'files', path: relativePath, section: action === 'share' ? 'share-review' : 'files' });
    return;
  }
  const file = await watcher.findFile(relativePath);
  if (!file) { await Electron.dialog.showMessageBox(target, { type: 'info', message: 'Sulla is still indexing this file. Try again after sync finishes.' }); return }
  if (action === 'copy-link') {
    // Any website or application can invoke the public URL scheme. Resolve the
    // actual file first, then require an explicit user action before publishing.
    const decision = await Electron.dialog.showMessageBox(target, {
      type: 'question',
      message: 'Create a share link for this file?',
      detail: relativePath,
      buttons: ['Cancel', 'Create and copy link'],
      defaultId: 0,
      cancelId: 0,
    });
    if (decision.response !== 1) return;
    const [configuredMode, keepAvailable, expiryDays] = await Promise.all([
      SullaSettingsModel.get('sullaFilesCaptureVisitorMode', 'view'),
      SullaSettingsModel.get('sullaFilesOrdinaryKeepAvailable', false),
      SullaSettingsModel.get('sullaFilesCaptureExpiryDays', 30),
    ]);
    const mode:ShareMode = configuredMode === 'download' ? 'download' : 'view';
    const days = Number(expiryDays);
    const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined;
    const link = await getSullaFilesLinkService().create({
      fileId:        file.id,
      mode,
      keepAvailable: keepAvailable === true,
      expiresAt,
    });

    Electron.clipboard.writeText(link.url);
    await Electron.dialog.showMessageBox(target, { type: 'info', message: 'Sulla link copied.', detail: link.name });
    return;
  }
  if (action === 'online-only' || action === 'keep') {
    if (action === 'online-only') {
      const decision = await Electron.dialog.showMessageBox(target, {
        type:    'warning',
        message: 'Free up space on this Mac?',
        detail: `${ relativePath }\n\nSulla will remove the local copy only after verifying authenticated remote recovery.`,
        buttons: ['Cancel', 'Free up space'],
        defaultId: 0,
        cancelId: 0,
      });
      if (decision.response !== 1) return;
    }
    const response = await watcher.requestFiles(`/v1/files/${ encodeURIComponent(file.id) }/residency`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ desiredState: action === 'online-only' ? 'online-only' : 'local' }),
      signal: AbortSignal.timeout(RESIDENCY_TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Residency request failed (${ response.status })`);
    }
    await Electron.dialog.showMessageBox(target, {
      type: 'info',
      message: action === 'online-only' ? 'Space freed after recovery verification.' : 'File kept on this Mac.',
      detail: relativePath,
    });
    return;
  }
  target.focus();
  target.webContents.send('agent-command', { command: 'open-tab', mode: 'files', fileId: file.id, path: relativePath, section: action === 'history' ? 'versions' : action === 'share' ? 'share-review' : 'files' });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
