// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import Logging from '@pkg/utils/logging';
import Electron, { WebContentsView } from 'electron';

import { VaultPermissionPolicy } from './vaultPermissionPolicy';
import type { CreatedVaultView, VaultOpenTimings, VaultTabHost, VaultViewReservation, VaultWindowState } from './vaultViewTypes';

import { configureVaultPinnedSession, VAULT_HTTPS_ORIGIN } from '@pkg/main/vaultTls';
import { vaultThemeCss } from '@pkg/shared/vaultTheme';
import { STARTUP_BACKGROUND } from '@pkg/config/theme';

const console = Logging.sulla;
export const VAULT_VIEW_KEEP_ALIVE_MS = 5 * 60_000;

const VAULT_ORIGIN = VAULT_HTTPS_ORIGIN;
// The vault page's "Integrations" side-menu link; intercepted here, never loaded.
const DESKTOP_INTEGRATIONS_PATH = '/vault/desktop/integrations';
// The guided connect screen navigates here after saving a new integration account.
const DESKTOP_CONNECTED_PATH = '/vault/desktop/connected';
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const permissionPolicy = new VaultPermissionPolicy(VAULT_ORIGIN);

export type { VaultViewReservation } from './vaultViewTypes';
/** Dedicated human-only vault view. It is never registered as a browser tab. */
export class VaultViewManager {
  private readonly windows = new Map<number, VaultWindowState>();

  private stateFor(window: Electron.BrowserWindow): VaultWindowState {
    let state = this.windows.get(window.id);
    if (!state) {
      state = {
        view: null, bounds: null, hostBounds: undefined, hostCleanup: null, attached: false, ready: false,
        isolatedSession: null, ownerId: null, attachedOwnerId: null, generation: 0, window,
        themeCss: '', themeKey: null, themeUpdate: Promise.resolve(), keepAliveTimer: null,
        expiryTimer: null, sessionExpiresAt: null, targetUrl: null,
      };
      this.windows.set(window.id, state);
      window.once('closed', () => { this.destroyWindow(window.id) });
    }
    return state;
  }

  reserve(window: Electron.BrowserWindow, ownerId: string): VaultViewReservation {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId)) throw new Error('Invalid vault view owner');
    const state = this.stateFor(window);
    this.clearKeepAlive(state);
    if (state.sessionExpiresAt !== null && state.sessionExpiresAt <= Date.now()) this.releaseAttachedView(state);
    else if (state.attachedOwnerId) this.releaseOwnerAttachment(state);
    state.ownerId = ownerId;
    state.generation += 1;
    return { ownerId, windowId: window.id, generation: state.generation };
  }

  isCurrent(reservation: VaultViewReservation): boolean {
    const state = this.windows.get(reservation.windowId);
    return !!state && state.ownerId === reservation.ownerId && state.generation === reservation.generation;
  }

  hasOwnerView(window: Electron.BrowserWindow, ownerId: string): boolean {
    const state = this.windows.get(window.id);
    return !!state && state.attachedOwnerId === ownerId && !!state.view && !state.view.webContents.isDestroyed();
  }

  hasActiveOwner(): boolean {
    return [...this.windows.values()].some(state => state.ownerId !== null);
  }

  async show(
    reservation: VaultViewReservation,
    window: Electron.BrowserWindow,
    url: string,
    bounds: Electron.Rectangle,
    host?: VaultTabHost,
    theme?: unknown,
    preparedView?: CreatedVaultView | null,
    timings?: VaultOpenTimings,
  ): Promise<boolean> {
    if (!this.isCurrent(reservation)) { this.discardPreparedView(preparedView ?? null); return false; }
    const target = this.validateUrl(url);
    const placement = this.validateBounds(bounds);
    const state = this.windows.get(reservation.windowId);
    if (!state || state.window !== window || window.isDestroyed()) throw new Error('Vault parent window is unavailable');
    state.themeCss = this.themeCssOrUnthemed(theme, 'open');
    const startedAt = performance.now();
    let created = preparedView ?? null;
    if (!state.view || state.view.webContents.isDestroyed() || !state.isolatedSession) {
      created ??= await this.createView(window);
      if (!this.isCurrent(reservation)) { this.discardCreatedView(created); return false; }
      state.view = created.view;
      state.isolatedSession = created.session;
      state.view.webContents.on('dom-ready', () => {
        if (state.view) void this.applyTheme(state, state.view).catch(error => console.warn('Vault theme update failed', error));
      });
    } else if (created) {
      this.discardCreatedView(created);
    }
    const view = state.view;
    if (!view) return false;
    const oldTarget = state.targetUrl ? new URL(state.targetUrl) : null;
    const sessionExpired = state.sessionExpiresAt !== null && state.sessionExpiresAt <= Date.now();
    const targetChanged = sessionExpired || !oldTarget || !this.samePageTarget(oldTarget, target);
    if (targetChanged && !oldTarget) state.themeKey = null;
    const dispose = host?.onDisposed(() => this.destroyOwner(reservation.ownerId, window));
    if (host && !dispose) {
      this.destroyOwner(reservation.ownerId, window);
      return false;
    }
    state.attachedOwnerId = reservation.ownerId;
    state.bounds = placement;
    if (host) {
      const unsubscribe = host.observeLayout((hostBounds, raised) => {
        if (!this.isCurrent(reservation)) return;
        state.hostBounds = hostBounds;
        this.placeView(state, raised);
      });
      state.hostCleanup = () => { unsubscribe(); dispose?.() };
    }
    const loadStartedAt = performance.now();
    try {
      if (targetChanged) await view.webContents.loadURL(target.toString());
      if (!this.isCurrent(reservation)) return false;
      state.targetUrl = target.toString();
      await this.applyTheme(state, view);
    } catch (error) {
      if (!this.isCurrent(reservation)) return false;
      this.destroyOwner(reservation.ownerId, window);
      throw error;
    }
    if (!this.isCurrent(reservation)) return false;
    state.ready = true;
    this.placeView(state);
    const loadURLMs = Math.round(performance.now() - loadStartedAt);
    timings?.onLoadURLComplete?.(loadURLMs);
    console.info(`[VaultView] open timing waitUntilStarted=${ timings?.waitUntilStartedMs ?? 0 }ms createHumanSession=${ timings?.createHumanSessionMs ?? 0 }ms createView=${ timings?.createViewMs ?? Math.round(loadStartedAt - startedAt) }ms loadURL=${ loadURLMs }ms total=${ Math.round(performance.now() - (timings?.requestedAt ?? startedAt)) }ms`);
    return this.isCurrent(reservation);
  }

  /** Prepare the expensive isolated renderer while the IPC layer creates its human session. */
  async prepareView(window: Electron.BrowserWindow): Promise<CreatedVaultView | null> {
    const state = this.stateFor(window);
    if (state.view && !state.view.webContents.isDestroyed() && state.isolatedSession) return null;
    return this.createView(window);
  }

  discardPreparedView(created: CreatedVaultView | null): void {
    if (created) this.discardCreatedView(created);
  }

  /** Auth grants are boot material; a live session already exchanged its grant. */
  private samePageTarget(previous: URL, next: URL): boolean {
    if (previous.origin !== next.origin || previous.pathname !== next.pathname) return false;
    const stable = (params: URLSearchParams) => [...params.entries()]
      .filter(([key]) => key !== 'grant' && key !== 'csrf')
      .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    return JSON.stringify(stable(previous.searchParams)) === JSON.stringify(stable(next.searchParams)) &&
      JSON.stringify(stable(new URLSearchParams(previous.hash.slice(1)))) === JSON.stringify(stable(new URLSearchParams(next.hash.slice(1))));
  }

  async setTheme(ownerId: string, theme: unknown, window: Electron.BrowserWindow): Promise<void> {
    const state = this.windows.get(window.id);
    if (state?.ownerId !== ownerId) return;
    const css = this.themeCssOrUnthemed(theme, 'update');
    state.themeCss = css;
    if (state.view) await this.applyTheme(state, state.view);
  }

  /** Presentation must never prevent the isolated vault UI from opening. */
  private themeCssOrUnthemed(theme: unknown, operation: 'open' | 'update'): string {
    if (theme === undefined) return '';
    try {
      return vaultThemeCss(theme);
    } catch (error) {
      console.warn(`Invalid vault theme during ${ operation }; opening without theme`, error);
      return '';
    }
  }

  private applyTheme(state: VaultWindowState, view: WebContentsView): Promise<void> {
    const update = state.themeUpdate.then(() => this.insertTheme(state, view));
    state.themeUpdate = update.catch(() => {});
    return update;
  }

  private async insertTheme(state: VaultWindowState, view: WebContentsView): Promise<void> {
    if (state.view !== view || view.webContents.isDestroyed() || !state.themeCss) return;
    const previous = state.themeKey;
    const key = await view.webContents.insertCSS(state.themeCss);
    if (state.view !== view || view.webContents.isDestroyed()) return;
    state.themeKey = key;
    if (previous) await view.webContents.removeInsertedCSS(previous);
  }

  setBounds(ownerId: string, bounds: Electron.Rectangle, window: Electron.BrowserWindow): void {
    const state = this.windows.get(window.id);
    if (state?.attachedOwnerId !== ownerId) return;
    state.bounds = this.validateBounds(bounds);
    this.placeView(state);
  }

  hide(ownerId: string, window: Electron.BrowserWindow): boolean {
    const state = this.windows.get(window.id);
    if (!state) return false;
    let released = false;
    if (state.ownerId === ownerId) {
      state.ownerId = null;
      state.generation += 1;
      released = true;
    }
    if (state.attachedOwnerId === ownerId) {
      this.releaseOwnerAttachment(state);
      this.clearKeepAlive(state);
      state.keepAliveTimer = setTimeout(() => this.releaseAttachedView(state), VAULT_VIEW_KEEP_ALIVE_MS);
      released = true;
    }
    return released;
  }

  private placeView(state: VaultWindowState, raised = false): void {
    const { window, view, bounds, hostBounds } = state;
    if (!state.ready || !view || !bounds || window.isDestroyed()) return;

    // A nested WebContentsView can load yet remain behind its host on macOS.
    // Place the isolated view in the window and clip it to its owner's tab.
    const x = hostBounds ? Math.max(0, bounds.x) : bounds.x;
    const y = hostBounds ? Math.max(0, bounds.y) : bounds.y;
    const width = hostBounds ? Math.min(hostBounds.width, bounds.x + bounds.width) - x : bounds.width;
    const height = hostBounds ? Math.min(hostBounds.height, bounds.y + bounds.height) - y : bounds.height;
    if (hostBounds === null || width < 1 || height < 1) {
      this.detachView(state);
      return;
    }
    view.setBounds({ x: x + (hostBounds?.x ?? 0), y: y + (hostBounds?.y ?? 0), width, height });
    if (!state.attached || raised) {
      if (!state.attached) window.setContentProtection(true);
      window.contentView.addChildView(view);
      state.attached = true;
    }
  }

  private detachView(state: VaultWindowState): void {
    if (state.attached && state.view && !state.window.isDestroyed()) {
      state.window.contentView.removeChildView(state.view);
      state.window.setContentProtection(false);
    }
    state.attached = false;
  }

  private releaseOwnerAttachment(state: VaultWindowState): void {
    state.hostCleanup?.();
    state.hostCleanup = null;
    this.detachView(state);
    state.ready = false;
    state.bounds = null;
    state.hostBounds = undefined;
    state.attachedOwnerId = null;
  }

  destroyOwner(ownerId: string, window: Electron.BrowserWindow): boolean {
    const state = this.windows.get(window.id);
    if (!state || (state.ownerId !== ownerId && state.attachedOwnerId !== ownerId)) return false;
    state.ownerId = null;
    state.generation += 1;
    this.releaseAttachedView(state);
    return true;
  }

  private clearKeepAlive(state: VaultWindowState): void {
    if (state.keepAliveTimer) clearTimeout(state.keepAliveTimer);
    state.keepAliveTimer = null;
  }

  private releaseAttachedView(state: VaultWindowState): void {
    this.clearKeepAlive(state);
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
    this.releaseOwnerAttachment(state);
    if (state.view && !state.view.webContents.isDestroyed()) state.view.webContents.close();
    state.view = null;
    state.themeKey = null;
    state.themeCss = '';
    void state.isolatedSession?.clearStorageData();
    state.isolatedSession = null;
    state.targetUrl = null;
    state.sessionExpiresAt = null;
    state.ownerId = null;
  }

  setSessionExpiry(windowId: number, expiresAt: number | string): void {
    const state = this.windows.get(windowId);
    const expiry = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
    if (!state || !Number.isFinite(expiry)) return;
    if (state.sessionExpiresAt !== null && state.sessionExpiresAt > Date.now()) return;
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    state.sessionExpiresAt = expiry;
    state.expiryTimer = setTimeout(() => this.releaseAttachedView(state), Math.max(0, expiry - Date.now()));
  }

  destroy(): void {
    for (const state of this.windows.values()) {
      state.ownerId = null;
      state.generation += 1;
      this.releaseAttachedView(state);
    }
  }

  private destroyWindow(windowId: number): void {
    const state = this.windows.get(windowId);
    if (!state) return;
    state.ownerId = null;
    state.generation += 1;
    this.releaseAttachedView(state);
    this.windows.delete(windowId);
  }

  owns(webContents: Electron.WebContents): boolean { return [...this.windows.values()].some(state => state.view?.webContents === webContents) }

  private async createView(window: Electron.BrowserWindow): Promise<CreatedVaultView> {
    // Never reuse a partition: hide() clears the old one asynchronously, and a
    // rapid reopen must not let that cleanup erase the new human session.
    const isolatedSession = Electron.session.fromPartition(`sulla-vault-human-${ process.pid }-${ randomUUID() }`, { cache: false });
    await configureVaultPinnedSession(isolatedSession);
    // Deny everything except the clipboard write the vault's Copy buttons need.
    isolatedSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permissionPolicy.allows(permission, requestingOrigin));
    isolatedSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permissionPolicy.allows(permission, details?.requestingUrl)));
    isolatedSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      try {
        callback({ cancel: new URL(details.url).origin !== VAULT_ORIGIN });
      } catch {
        callback({ cancel: true });
      }
    });
    isolatedSession.webRequest.onHeadersReceived({ urls: [`${ VAULT_ORIGIN }/*`] }, (details, callback) => {
      const headers = { ...details.responseHeaders };
      headers['Content-Security-Policy'] = [
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
      ];
      callback({ responseHeaders: headers });
    });
    const view = new WebContentsView({
      webPreferences: {
        session: isolatedSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor(STARTUP_BACKGROUND);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, url) => {
      try {
        const target = new URL(url);
        if (target.origin === VAULT_ORIGIN && target.pathname === DESKTOP_INTEGRATIONS_PATH) {
          event.preventDefault();
          if (!window.isDestroyed()) window.webContents.send('agent-command', { command: 'open-tab', mode: 'integrations' });
        } else if (target.origin === VAULT_ORIGIN && target.pathname === DESKTOP_CONNECTED_PATH) {
          event.preventDefault();
          const integrationId = target.searchParams.get('integration') ?? '';
          const accountId = target.searchParams.get('account') ?? '';
          if (SAFE_ID.test(integrationId) && SAFE_ID.test(accountId)) {
            if (!window.isDestroyed()) window.webContents.send('agent-command', { command: 'vault-integration-saved', integrationId, accountId });
          }
        } else if (target.origin !== VAULT_ORIGIN) {
          event.preventDefault();
        }
      } catch { event.preventDefault() }
    });
    view.webContents.on('will-attach-webview', event => event.preventDefault());
    return { view, session: isolatedSession };
  }

  private discardCreatedView(created: CreatedVaultView): void {
    if (!created.view.webContents.isDestroyed()) created.view.webContents.close();
    void created.session.clearStorageData();
  }

  private validateUrl(raw: string): URL {
    const url = new URL(raw);
    if (url.origin !== VAULT_ORIGIN || !url.pathname.startsWith('/vault/')) throw new Error('Invalid vault UI URL');
    return url;
  }

  private validateBounds(bounds: Electron.Rectangle): Electron.Rectangle {
    const values = [bounds?.x, bounds?.y, bounds?.width, bounds?.height];
    if (!values.every(Number.isFinite) || bounds.width < 1 || bounds.height < 1) throw new Error('Invalid vault view bounds');
    return { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) };
  }
}

export const vaultViewManager = new VaultViewManager();
