// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import Logging from '@pkg/utils/logging';
import type { WebContentsView } from 'electron';

import { VaultRendererFactory, type CreatedVaultView } from './VaultRendererFactory';

import { VAULT_HTTPS_ORIGIN } from '@pkg/main/vaultTls';
import { vaultThemeCss } from '@pkg/shared/vaultTheme';

const console = Logging.sulla;
export const VAULT_VIEW_KEEP_ALIVE_MS = 5 * 60_000;

const VAULT_ORIGIN = VAULT_HTTPS_ORIGIN;

export interface VaultViewReservation {
  ownerId:    string;
  windowId:   number;
  generation: number;
}

interface VaultTabHost {
  observeLayout(listener: (bounds: Electron.Rectangle | null, raised: boolean) => void): () => void;
  onDisposed(listener: () => void): (() => void) | null;
}

interface VaultWindowState {
  view: WebContentsView | null;
  bounds: Electron.Rectangle | null;
  hostBounds: Electron.Rectangle | null | undefined;
  hostCleanup: (() => void) | null;
  attached: boolean;
  ready: boolean;
  isolatedSession: Electron.Session | null;
  ownerId: string | null;
  attachedOwnerId: string | null;
  generation: number;
  themeCss: string;
  themeKey: string | null;
  themeUpdate: Promise<void>;
  keepAliveTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  sessionExpiresAt: number | null;
  targetUrl: string | null;
  window: Electron.BrowserWindow;
}

interface VaultOpenTimings {
  requestedAt: number;
  waitUntilStartedMs: number;
  createHumanSessionMs: number;
  createViewMs: number;
  onLoadURLComplete?: (durationMs: number) => void;
}

/** Dedicated human-only vault view. It is never registered as a browser tab. */
export class VaultViewManager {
  private readonly windows = new Map<number, VaultWindowState>();

  private stateFor(window: Electron.BrowserWindow): VaultWindowState {
    let state = this.windows.get(window.id);
    if (!state) {
      state = {
        view: null, bounds: null, hostBounds: undefined, hostCleanup: null, attached: false, ready: false,
        isolatedSession: null, ownerId: null, attachedOwnerId: null, generation: 0, window, themeCss: '',
        themeKey: null, themeUpdate: Promise.resolve(), keepAliveTimer: null, expiryTimer: null,
        sessionExpiresAt: null, targetUrl: null,
      };
      this.windows.set(window.id, state);
      window.once('closed', () => { this.destroyWindow(window.id) });
    }
    return state;
  }

  reserve(window: Electron.BrowserWindow, ownerId: string): VaultViewReservation {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId)) throw new Error('Invalid vault view owner');
    const state = this.stateFor(window);
    state.ownerId = ownerId;
    state.generation += 1;
    this.clearKeepAlive(state);
    if (state.sessionExpiresAt !== null && state.sessionExpiresAt <= Date.now()) {
      if (state.expiryTimer) clearTimeout(state.expiryTimer);
      state.expiryTimer = null;
    }
    this.clearPlacement(state);
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
    let target: URL;
    let placement: Electron.Rectangle;
    const state = this.windows.get(reservation.windowId);
    try {
      target = this.validateUrl(url);
      placement = this.validateBounds(bounds);
      if (!state || state.window !== window || window.isDestroyed()) throw new Error('Vault parent window is unavailable');
    } catch (error) {
      // The prepared renderer and its session are not adopted yet; nothing else would close them.
      this.discardPreparedView(preparedView ?? null);
      throw error;
    }
    state.themeCss = this.themeCssOrUnthemed(theme, 'open');
    const startedAt = performance.now();
    if (!state.view || state.view.webContents.isDestroyed() || !state.isolatedSession) {
      const created = preparedView ?? await this.createView(window);
      if (!this.isCurrent(reservation)) { this.discardCreatedView(created); return false; }
      state.view = created.view;
      state.isolatedSession = created.session;
      state.targetUrl = null;
      const { view } = created;
      view.webContents.on('dom-ready', () => {
        if (state.view !== view) return;
        state.themeKey = null;
        void this.paintTheme(state, view);
      });
    } else {
      this.discardPreparedView(preparedView ?? null);
    }

    const view = state.view;
    const oldTarget = state.targetUrl ? new URL(state.targetUrl) : null;
    const sessionExpired = state.sessionExpiresAt !== null && state.sessionExpiresAt <= Date.now();
    const targetChanged = sessionExpired || !oldTarget || !this.samePageTarget(oldTarget, target);
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
      const previousPaint = state.themeUpdate;
      if (targetChanged) await view.webContents.loadURL(target.toString());
      if (!this.isCurrent(reservation)) return false;
      state.targetUrl = target.toString();
      await (state.themeUpdate === previousPaint ? this.paintTheme(state, view) : state.themeUpdate);
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
    console.info(`[VaultView] open timing waitUntilStarted=${timings?.waitUntilStartedMs ?? 0}ms createHumanSession=${timings?.createHumanSessionMs ?? 0}ms createView=${timings?.createViewMs ?? Math.round(loadStartedAt - startedAt)}ms loadURL=${loadURLMs}ms total=${Math.round(performance.now() - (timings?.requestedAt ?? startedAt))}ms`);
    return true;
  }

  private paintTheme(state: VaultWindowState, view: WebContentsView): Promise<void> {
    return this.applyTheme(state, view).catch(error => console.warn('Vault theme update failed', error));
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

  /** Auth grants are single-use boot material; a live session already exchanged its grant. */
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
      this.clearPlacement(state);
      this.clearKeepAlive(state);
      state.keepAliveTimer = setTimeout(() => this.releaseAttachedView(state), VAULT_VIEW_KEEP_ALIVE_MS);
      released = true;
    }
    return released;
  }

  destroyOwner(ownerId: string, window: Electron.BrowserWindow): boolean {
    const state = this.windows.get(window.id);
    if (!state || (state.ownerId !== ownerId && state.attachedOwnerId !== ownerId)) return false;
    state.ownerId = null;
    state.generation += 1;
    this.releaseAttachedView(state);
    return true;
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

  private clearPlacement(state: VaultWindowState): void {
    state.hostCleanup?.();
    state.hostCleanup = null;
    this.detachView(state);
    state.ready = false;
    state.bounds = null;
    state.hostBounds = undefined;
    state.attachedOwnerId = null;
  }

  private clearKeepAlive(state: VaultWindowState): void {
    if (state.keepAliveTimer) clearTimeout(state.keepAliveTimer);
    state.keepAliveTimer = null;
  }

  private releaseAttachedView(state: VaultWindowState): void {
    this.clearKeepAlive(state);
    if (state.expiryTimer) clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
    this.clearPlacement(state);
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

  private createView(window: Electron.BrowserWindow): Promise<CreatedVaultView> {
    return VaultRendererFactory.create(window);
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
