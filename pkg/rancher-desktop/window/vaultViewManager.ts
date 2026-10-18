import { randomUUID } from 'node:crypto';

import Electron, { WebContentsView } from 'electron';

import { configureVaultPinnedSession, VAULT_HTTPS_ORIGIN } from '@pkg/main/vaultTls';
import { getWindow } from '@pkg/window';

const VAULT_ORIGIN = VAULT_HTTPS_ORIGIN;

export interface VaultViewReservation {
  ownerId:    string;
  generation: number;
}

interface CreatedVaultView {
  view:    WebContentsView;
  session: Electron.Session;
}

/** Dedicated human-only vault view. It is never registered as a browser tab. */
export class VaultViewManager {
  private view: WebContentsView | null = null;
  private attached = false;
  private isolatedSession: Electron.Session | null = null;
  private ownerId: string | null = null;
  private attachedOwnerId: string | null = null;
  private generation = 0;

  reserve(ownerId: string): VaultViewReservation {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId)) throw new Error('Invalid vault view owner');
    this.ownerId = ownerId;
    this.generation += 1;
    this.releaseAttachedView();
    return { ownerId, generation: this.generation };
  }

  isCurrent(reservation: VaultViewReservation): boolean {
    return this.ownerId === reservation.ownerId && this.generation === reservation.generation;
  }

  hasActiveOwner(): boolean {
    return this.ownerId !== null;
  }

  async show(reservation: VaultViewReservation, url: string, bounds: Electron.Rectangle): Promise<boolean> {
    if (!this.isCurrent(reservation)) return false;
    const target = this.validateUrl(url);
    const mainWindow = getWindow('main-agent');
    if (!mainWindow) throw new Error('Main window is unavailable');
    const created = await this.createView();
    if (!this.isCurrent(reservation)) {
      this.discardCreatedView(created);
      return false;
    }
    const { view } = created;
    this.view = view;
    this.isolatedSession = created.session;
    this.attachedOwnerId = reservation.ownerId;
    view.setBounds(this.validateBounds(bounds));
    mainWindow.contentView.addChildView(view);
    this.attached = true;
    // Defense in depth for ordinary OS capture paths. The stronger guarantee
    // is that this view is absent from every browser/agent automation registry.
    mainWindow.setContentProtection(true);
    try {
      await view.webContents.loadURL(target.toString());
    } catch (error) {
      if (!this.isCurrent(reservation)) return false;
      this.hide(reservation.ownerId);
      throw error;
    }
    return this.isCurrent(reservation);
  }

  setBounds(ownerId: string, bounds: Electron.Rectangle): void {
    if (this.attachedOwnerId !== ownerId) return;
    this.view?.setBounds(this.validateBounds(bounds));
  }

  hide(ownerId: string): boolean {
    let released = false;
    if (this.ownerId === ownerId) {
      this.ownerId = null;
      this.generation += 1;
      released = true;
    }
    if (this.attachedOwnerId === ownerId) {
      this.releaseAttachedView();
      released = true;
    }
    return released;
  }

  private releaseAttachedView(): void {
    const mainWindow = getWindow('main-agent');
    if (mainWindow && this.view && this.attached) mainWindow.contentView.removeChildView(this.view);
    this.attached = false;
    mainWindow?.setContentProtection(false);
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    void this.isolatedSession?.clearStorageData();
    this.isolatedSession = null;
    this.attachedOwnerId = null;
  }

  destroy(): void {
    this.ownerId = null;
    this.generation += 1;
    this.releaseAttachedView();
  }

  owns(webContents: Electron.WebContents): boolean { return this.view?.webContents === webContents }

  private async createView(): Promise<CreatedVaultView> {
    // Never reuse a partition: hide() clears the old one asynchronously, and a
    // rapid reopen must not let that cleanup erase the new human session.
    const isolatedSession = Electron.session.fromPartition(`sulla-vault-human-${ process.pid }-${ randomUUID() }`, { cache: false });
    await configureVaultPinnedSession(isolatedSession);
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
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
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event, url) => {
      try { if (new URL(url).origin !== VAULT_ORIGIN) event.preventDefault() } catch { event.preventDefault() }
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
