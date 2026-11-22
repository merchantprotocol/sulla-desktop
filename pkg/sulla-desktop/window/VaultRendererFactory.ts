// SPDX-License-Identifier: GPL-2.0-or-later
import { randomUUID } from 'node:crypto';
import Electron, { WebContentsView } from 'electron';

import { STARTUP_BACKGROUND } from '@pkg/config/theme';
import { configureVaultPinnedSession, VAULT_HTTPS_ORIGIN } from '@pkg/main/vaultTls';
import { VaultPermissionPolicy } from './vaultPermissionPolicy';

const VAULT_ORIGIN = VAULT_HTTPS_ORIGIN;
// The vault page's "Integrations" side-menu link; intercepted here, never loaded.
const DESKTOP_INTEGRATIONS_PATH = '/vault/desktop/integrations';
// The guided connect screen navigates here after saving a new integration account.
const DESKTOP_CONNECTED_PATH = '/vault/desktop/connected';
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const permissionPolicy = new VaultPermissionPolicy(VAULT_ORIGIN);

export interface CreatedVaultView {
  view:    WebContentsView;
  session: Electron.Session;
}

/** Creates a vault-only renderer and its isolated, pinned session. */
export class VaultRendererFactory {
  static async create(window: Electron.BrowserWindow): Promise<CreatedVaultView> {
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
}
