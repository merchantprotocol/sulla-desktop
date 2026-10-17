import { randomUUID } from 'node:crypto';

import Electron, { WebContentsView } from 'electron';

import { configureVaultPinnedSession, VAULT_HTTPS_ORIGIN } from '@pkg/main/vaultTls';
import { getWindow } from '@pkg/window';

const VAULT_ORIGIN = VAULT_HTTPS_ORIGIN;

/** Dedicated human-only vault view. It is never registered as a browser tab. */
export class VaultViewManager {
  private view: WebContentsView | null = null;
  private attached = false;
  private isolatedSession: Electron.Session | null = null;

  async show(url: string, bounds: Electron.Rectangle): Promise<void> {
    const target = this.validateUrl(url);
    const mainWindow = getWindow('main-agent');
    if (!mainWindow) throw new Error('Main window is unavailable');
    const view = this.view ?? await this.createView();
    this.view = view;
    view.setBounds(this.validateBounds(bounds));
    if (!this.attached) {
      mainWindow.contentView.addChildView(view);
      this.attached = true;
    }
    // Defense in depth for ordinary OS capture paths. The stronger guarantee
    // is that this view is absent from every browser/agent automation registry.
    mainWindow.setContentProtection(true);
    await view.webContents.loadURL(target.toString());
  }

  setBounds(bounds: Electron.Rectangle): void {
    this.view?.setBounds(this.validateBounds(bounds));
  }

  hide(): void {
    const mainWindow = getWindow('main-agent');
    if (mainWindow && this.view && this.attached) mainWindow.contentView.removeChildView(this.view);
    this.attached = false;
    mainWindow?.setContentProtection(false);
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    void this.isolatedSession?.clearStorageData();
    this.isolatedSession = null;
  }

  destroy(): void {
    this.hide();
  }

  owns(webContents: Electron.WebContents): boolean { return this.view?.webContents === webContents }

  private async createView(): Promise<WebContentsView> {
    // Never reuse a partition: hide() clears the old one asynchronously, and a
    // rapid reopen must not let that cleanup erase the new human session.
    const isolatedSession = Electron.session.fromPartition(`sulla-vault-human-${ process.pid }-${ randomUUID() }`, { cache: false });
    await configureVaultPinnedSession(isolatedSession);
    this.isolatedSession = isolatedSession;
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
    return view;
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
