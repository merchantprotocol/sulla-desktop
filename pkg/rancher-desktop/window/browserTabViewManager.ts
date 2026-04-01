import path from 'path';

import Electron, { WebContentsView, session } from 'electron';

import { SullaWebRequestFixer } from '@pkg/SullaWebRequestFixer';
import { buildContextMenuInjection } from '@pkg/window/browserContextMenu';
import paths from '@pkg/utils/paths';
import Logging from '@pkg/utils/logging';
import { getWindow } from '@pkg/window';

const console = Logging.sulla;

const SESSION_PARTITION = 'persist:sulla-browser';

/**
 * Manages WebContentsView instances for browser tabs.
 *
 * Each tab gets its own real Chromium renderer with first-party cookie/storage
 * access, replacing the previous iframe approach that broke cookies/storage in
 * third-party contexts.
 *
 * All tabs share a single session partition (`persist:sulla-browser`) so that
 * login state in one tab is visible in another — just like a real browser.
 */
export class BrowserTabViewManager {
  private static instance: BrowserTabViewManager | undefined;

  private views = new Map<string, WebContentsView>();
  private failedUrls = new Map<string, string>(); // tabId → original URL that failed
  private retryTimers = new Map<string, ReturnType<typeof setInterval>>();
  private acceptedCertHosts = new Set<string>(); // hosts where user clicked "Proceed"
  /** Credentials captured but not yet saved — keyed by tabId, auto-expires after 90s */
  private pendingCredentials = new Map<string, { origin: string; username: string; password: string; timer: ReturnType<typeof setTimeout>; pageTitle?: string; existingAccountId?: string }>();
  private sessionInitialised = false;
  private webRequestFixer: SullaWebRequestFixer | null = null;

  private constructor() {}

  static getInstance(): BrowserTabViewManager {
    if (!BrowserTabViewManager.instance) {
      BrowserTabViewManager.instance = new BrowserTabViewManager();
    }

    return BrowserTabViewManager.instance;
  }

  /**
   * Lazily initialise the shared session and attach the SullaWebRequestFixer
   * so cookie management works for all browser-tab views.
   */
  private ensureSession(): Electron.Session {
    const sess = session.fromPartition(SESSION_PARTITION);

    if (!this.sessionInitialised) {
      this.webRequestFixer = new SullaWebRequestFixer((event) => {
        console.log('[BrowserTabView] webRequest event:', JSON.stringify(event));
      });

      this.webRequestFixer.attachToSession(sess);

      // Set a clean User-Agent that matches a normal Chrome browser.
      // The default includes "Electron" and "SullaDesktop" which fingerprint
      // us and can trigger bot detection on social sites.
      const defaultUA = sess.getUserAgent();
      const cleanUA = defaultUA
        .replace(/\s*SullaDesktop\/[\d.]+/i, '')
        .replace(/\s*Electron\/[\d.]+/i, '');

      sess.setUserAgent(cleanUA);

      // Persist session cookies across app restarts.  Many apps (e.g. Twenty
      // CRM) store auth tokens as session cookies that would otherwise be
      // cleared when Electron exits.  Real browsers like Chrome also persist
      // session cookies when "Continue where you left off" is enabled.
      sess.cookies.flushStore().catch(() => {});
      sess.on('will-download', () => {}); // ensure session stays alive

      // Override cookie persistence: when a session cookie is set, re-set it
      // with a far-future expiry so it survives app restarts.
      sess.cookies.on('changed', (_event, cookie, _cause, removed) => {
        if (removed) return;
        // Only promote session cookies (those without an expiry)
        if (cookie.expirationDate) return;

        const url = `http${ cookie.secure ? 's' : '' }://${ (cookie.domain || '').replace(/^\./, '') }${ cookie.path || '/' }`;

        sess.cookies.set({
          url,
          name:           cookie.name,
          value:          cookie.value,
          domain:         cookie.domain || undefined,
          path:           cookie.path || '/',
          secure:         cookie.secure,
          httpOnly:       cookie.httpOnly,
          sameSite:       cookie.sameSite as any,
          expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60, // 1 year
        }).catch(() => {});
      });

      // Register the browser tab preload script so the guest bridge is
      // injected at document-start — before any page JavaScript runs.
      const preloadId = 'sulla-browser-tab-preload';

      if (!sess.getPreloadScripts().some((s) => s.id === preloadId)) {
        sess.registerPreloadScript({
          id:       preloadId,
          filePath: path.join(paths.resources, 'browserTabPreload.js'),
          type:     'frame',
        });
      }

      this.sessionInitialised = true;
      console.log('[BrowserTabView] Session initialised:', SESSION_PARTITION);
    }

    return sess;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  createView(tabId: string, url: string, bounds: Electron.Rectangle): void {
    if (this.views.has(tabId)) {
      console.warn(`[BrowserTabView] View already exists for tabId=${ tabId }, destroying first`);
      this.destroyView(tabId);
    }

    const mainWindow = getWindow('main-agent');

    if (!mainWindow) {
      throw new Error('[BrowserTabView] Cannot create view — main window not found');
    }

    // Make sure shared session is ready
    this.ensureSession();

    const view = new WebContentsView({
      webPreferences: {
        webSecurity:      false,
        contextIsolation: false,
        nodeIntegration:  false,
        partition:        SESSION_PARTITION,
      },
    });

    view.setBounds(bounds);
    // Do NOT add to window yet — the view stays hidden until showView() is
    // called.  This prevents new tabs from overlaying the current screen.
    this.views.set(tabId, view);

    // Wire up event listeners that forward state to the renderer
    this.attachListeners(tabId, view, mainWindow);

    view.webContents.loadURL(url).catch((err) => {
      console.error(`[BrowserTabView] Failed to load URL for tabId=${ tabId }:`, err);
    });

    console.log(`[BrowserTabView] Created view tabId=${ tabId } url=${ url }`);
  }

  destroyView(tabId: string): void {
    const view = this.views.get(tabId);

    if (!view) {
      return;
    }

    const mainWindow = getWindow('main-agent');

    if (mainWindow) {
      try {
        mainWindow.contentView.removeChildView(view);
      } catch { /* view may already be detached */ }
    }

    // Destroy the underlying webContents
    this.stopRetry(tabId);
    (view.webContents as any).close?.();
    this.views.delete(tabId);
    this.failedUrls.delete(tabId);
    this.clearPendingCredentials(tabId);
    console.log(`[BrowserTabView] Destroyed view tabId=${ tabId }`);
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  navigateTo(tabId: string, url: string): void {
    const wc = this.getWebContents(tabId);

    if (wc) {
      wc.loadURL(url).catch((err) => {
        console.error(`[BrowserTabView] navigateTo failed for tabId=${ tabId }:`, err);
      });
    }
  }

  goBack(tabId: string): void {
    this.getWebContents(tabId)?.goBack();
  }

  goForward(tabId: string): void {
    this.getWebContents(tabId)?.goForward();
  }

  reload(tabId: string): void {
    this.getWebContents(tabId)?.reload();
  }

  stop(tabId: string): void {
    this.getWebContents(tabId)?.stop();
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  setBounds(tabId: string, bounds: Electron.Rectangle): void {
    const view = this.views.get(tabId);

    if (view) {
      view.setBounds(bounds);
    }
  }

  showView(tabId: string): void {
    const view = this.views.get(tabId);
    const mainWindow = getWindow('main-agent');

    if (!view || !mainWindow) {
      return;
    }

    // addChildView is safe to call even if already added — Electron deduplicates
    mainWindow.contentView.addChildView(view);
  }

  hideView(tabId: string): void {
    const view = this.views.get(tabId);
    const mainWindow = getWindow('main-agent');

    if (!view || !mainWindow) {
      return;
    }

    try {
      mainWindow.contentView.removeChildView(view);
    } catch { /* may already be removed */ }
  }

  // ---------------------------------------------------------------------------
  // Scripting
  // ---------------------------------------------------------------------------

  async executeJavaScript(tabId: string, code: string): Promise<unknown> {
    const wc = this.getWebContents(tabId);

    if (!wc) {
      return undefined;
    }

    try {
      return await wc.executeJavaScript(code, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      console.error(`[BrowserTabViewManager] executeJavaScript failed for tab ${ tabId }: ${ message }`);

      return {
        error:      message,
        errorStack: err instanceof Error ? err.stack : undefined,
        result:     undefined,
        logs:       [],
        sullaLog:   [],
        timing:     0,
        mutations:  0,
        navigated:  false,
        url:        '',
        title:      '',
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  getWebContents(tabId: string): Electron.WebContents | null {
    return this.views.get(tabId)?.webContents ?? null;
  }

  /** Returns the SullaWebRequestFixer instance for the shared browser session. */
  getWebRequestFixer(): SullaWebRequestFixer | null {
    return this.webRequestFixer;
  }

  /**
   * Mark a host's certificate as accepted and reload the tab.
   * Called when the user clicks "Proceed" on the certificate warning page.
   */
  acceptCertificate(tabId: string): void {
    const originalUrl = this.failedUrls.get(tabId);

    if (!originalUrl) {
      console.warn(`[BrowserTabView] acceptCertificate: no failed URL for tabId=${ tabId }`);

      return;
    }

    try {
      const host = new URL(originalUrl).host;

      this.acceptedCertHosts.add(host);
      console.log(`[BrowserTabView] Certificate accepted for host=${ host }`);
    } catch {
      console.warn(`[BrowserTabView] acceptCertificate: invalid URL ${ originalUrl }`);

      return;
    }

    this.failedUrls.delete(tabId);

    const wc = this.getWebContents(tabId);

    if (wc) {
      wc.loadURL(originalUrl).catch((err) => {
        console.error(`[BrowserTabView] acceptCertificate reload failed:`, err);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-retry for failed loads
  // ---------------------------------------------------------------------------

  private static readonly RETRY_INTERVAL_MS = 5_000;

  /**
   * Start silently polling a URL that failed to load.  When the server
   * responds (any HTTP status), stop polling and reload the page.
   */
  private startRetry(tabId: string, url: string): void {
    this.stopRetry(tabId); // clear any existing timer

    const timer = setInterval(async() => {
      try {
        // Use a lightweight HEAD request with a short timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3_000);

        await Electron.net.fetch(url, {
          method: 'HEAD',
          signal: controller.signal as any,
        });
        clearTimeout(timeout);

        // Server responded — reload the page
        console.log(`[BrowserTabView] Auto-retry: ${ url } is now reachable, reloading tabId=${ tabId }`);
        this.stopRetry(tabId);
        const wc = this.getWebContents(tabId);

        if (wc) {
          wc.loadURL(url).catch(() => {});
        }
      } catch {
        // Still unreachable — keep polling
      }
    }, BrowserTabViewManager.RETRY_INTERVAL_MS);

    this.retryTimers.set(tabId, timer);
    console.log(`[BrowserTabView] Auto-retry started for tabId=${ tabId } url=${ url } (every ${ BrowserTabViewManager.RETRY_INTERVAL_MS / 1000 }s)`);
  }

  private stopRetry(tabId: string): void {
    const timer = this.retryTimers.get(tabId);

    if (timer) {
      clearInterval(timer);
      this.retryTimers.delete(tabId);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Attach webContents event listeners that forward navigation/loading state
   * back to the renderer process via the MAIN window's webContents.
   */
  /**
   * Check if the vault has saved credentials for the given origin.
   * If so, send an autofill offer to the renderer.
   */
  private async checkVaultForAutofill(tabId: string, origin: string, mainWindow: Electron.BrowserWindow): Promise<void> {
    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const service = getIntegrationService();
      const accounts = await service.getAccounts('website');
      const matches: { accountId: string; username: string }[] = [];

      for (const acct of accounts) {
        const urlValue = await service.getIntegrationValue('website', 'website_url', acct.account_id);
        if (!urlValue?.value) continue;

        try {
          const savedOrigin = new URL(urlValue.value).origin;
          if (savedOrigin === origin) {
            const usernameValue = await service.getIntegrationValue('website', 'username', acct.account_id);
            matches.push({
              accountId: acct.account_id,
              username:  usernameValue?.value || acct.label,
            });
          }
        } catch { /* invalid saved URL */ }
      }

      if (matches.length > 0 && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vault:autofill-offer', {
          tabId,
          origin,
          accounts: matches,
        });
      }
    } catch (err) {
      console.error('[BrowserTabView] checkVaultForAutofill error:', err);
    }
  }

  /**
   * Send matching vault accounts to the guest page via executeJavaScript.
   * The page's __sullaVaultSetAccounts() will receive them and show the dropdown.
   */
  private async sendVaultMatchesToPage(tabId: string, origin: string): Promise<void> {
    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const service = getIntegrationService();
      const accounts = await service.getAccounts('website');
      const matches: { accountId: string; username: string; origin: string }[] = [];

      for (const acct of accounts) {
        const urlValue = await service.getIntegrationValue('website', 'website_url', acct.account_id);
        if (!urlValue?.value) continue;
        try {
          const savedOrigin = new URL(urlValue.value).origin;
          if (savedOrigin === origin) {
            const usernameValue = await service.getIntegrationValue('website', 'username', acct.account_id);
            matches.push({
              accountId: acct.account_id,
              username:  usernameValue?.value || acct.label,
              origin:    savedOrigin,
            });
          }
        } catch { /* invalid URL */ }
      }

      const view = this.views.get(tabId);
      if (view && matches.length > 0) {
        const script = `window.__sullaVaultSetAccounts(${ JSON.stringify(matches) });`;
        view.webContents.executeJavaScript(script, true).catch(() => {});
      }
    } catch (err) {
      console.error('[BrowserTabView] sendVaultMatchesToPage error:', err);
    }
  }

  /**
   * Save a captured credential to the vault as a website integration account.
   */
  private async saveVaultCredential(origin: string, username: string, password: string, pageTitle?: string): Promise<void> {
    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const service = getIntegrationService();
      await service.initialize();

      const accountId = (origin + '_' + username)
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 200);

      // Derive a nice label: use page title if available, otherwise domain
      const domain = origin.replace(/^https?:\/\//, '').replace(/^www\./, '');
      let label = domain;
      if (pageTitle) {
        // Clean up common suffixes like " - Login", " | Sign In", " - Log In"
        const cleanTitle = pageTitle
          .replace(/\s*[-|–—]\s*(log\s*in|sign\s*in|login|signin|account).*$/i, '')
          .replace(/\s*[-|–—]\s*$/, '')
          .trim();
        if (cleanTitle && cleanTitle.length > 1 && cleanTitle.length < 60) {
          label = cleanTitle;
        }
      }

      await service.setFormValues([
        { integration_id: 'website', account_id: accountId, property: 'website_url', value: origin },
        { integration_id: 'website', account_id: accountId, property: 'username', value: username },
        { integration_id: 'website', account_id: accountId, property: 'password', value: password },
        { integration_id: 'website', account_id: accountId, property: 'llm_access', value: 'autofill' },
      ]);
      await service.setAccountLabel('website', accountId, `${ label } (${ username })`);
      await service.setConnectionStatus('website', true, accountId);
      console.log(`[BrowserTabView] Vault credential saved: ${ label } (${ username })`);
    } catch (err) {
      console.error('[BrowserTabView] saveVaultCredential error:', err);
    }
  }

  /**
   * Update only the password for an existing vault account.
   */
  private async updateVaultPassword(accountId: string, password: string): Promise<void> {
    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const service = getIntegrationService();
      await service.initialize();

      await service.setIntegrationValue({
        integration_id: 'website',
        account_id:     accountId,
        property:       'password',
        value:          password,
      });
      console.log(`[BrowserTabView] Vault password updated for account: ${ accountId }`);
    } catch (err) {
      console.error('[BrowserTabView] updateVaultPassword error:', err);
    }
  }

  /**
   * Autofill a login form by decrypting vault credentials and injecting directly.
   * Password goes from main process → tab JS, never enters LLM context.
   */
  /**
   * Check existing vault accounts and decide whether to show a save/update toast.
   * - Same username + same password → skip (already saved)
   * - Same username + different password → show "Update password?" toast
   * - New username → show "Save new account?" toast
   */
  private async setPendingCredentials(tabId: string, origin: string, username: string, password: string, pageTitle?: string): Promise<void> {
    this.clearPendingCredentials(tabId);

    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const service = getIntegrationService();
      const accounts = await service.getAccounts('website');

      // Check if we already have this exact credential
      for (const acct of accounts) {
        const urlValue = await service.getIntegrationValue('website', 'website_url', acct.account_id);
        if (!urlValue?.value) continue;

        try {
          const savedOrigin = new URL(urlValue.value).origin;
          if (savedOrigin !== origin) continue;
        } catch { continue; }

        const savedUsername = await service.getIntegrationValue('website', 'username', acct.account_id);
        if (savedUsername?.value !== username) continue;

        // Username matches — check password
        const savedPassword = await service.getIntegrationValue('website', 'password', acct.account_id);
        if (savedPassword?.value === password) {
          // Exact match — already saved, don't show toast
          console.log(`[BrowserTabView] Credential already saved for ${ username } @ ${ origin }`);
          return;
        }

        // Username matches but password changed — show update toast
        const timer = setTimeout(() => this.clearPendingCredentials(tabId), 90_000);
        this.pendingCredentials.set(tabId, {
          origin, username, password, timer, pageTitle,
          existingAccountId: acct.account_id,
        });
        this.pushSaveToastToPage(tabId, true);
        return;
      }

      // No matching username — show save-new toast
      const timer = setTimeout(() => this.clearPendingCredentials(tabId), 90_000);
      this.pendingCredentials.set(tabId, {
        origin, username, password, timer, pageTitle,
      });
      this.pushSaveToastToPage(tabId, false);
    } catch (err) {
      console.error('[BrowserTabView] setPendingCredentials check failed:', err);
      // Fallback: show save toast anyway
      const timer = setTimeout(() => this.clearPendingCredentials(tabId), 90_000);
      this.pendingCredentials.set(tabId, {
        origin, username, password, timer, pageTitle,
      });
      this.pushSaveToastToPage(tabId, false);
    }
  }

  private clearPendingCredentials(tabId: string): void {
    const pending = this.pendingCredentials.get(tabId);

    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCredentials.delete(tabId);
    }
  }

  private pushSaveToastToPage(tabId: string, isUpdate: boolean): void {
    const pending = this.pendingCredentials.get(tabId);

    if (!pending) {
      return;
    }
    const view = this.views.get(tabId);

    if (!view) {
      return;
    }
    const action = isUpdate ? 'Update' : 'Save';
    const script = `window.__sullaVaultShowPendingSaveToast(${ JSON.stringify(pending.origin) }, ${ JSON.stringify(pending.username) }, ${ JSON.stringify(action) });`;

    view.webContents.executeJavaScript(script, true).catch(() => {});
  }

  private async autofillVaultCredential(tabId: string, accountId: string): Promise<void> {
    try {
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const service = getIntegrationService();
      await service.initialize();

      const formValues = await service.getFormValues('website', accountId);
      const stored: Record<string, string> = {};
      for (const fv of formValues) {
        stored[fv.property] = fv.value;
      }

      const username = stored['username'] || '';
      const password = stored['password'] || '';
      if (!username && !password) return;

      const view = this.views.get(tabId);
      if (!view) return;

      const script = `
        (function() {
          var b = window.sullaBridge;
          if (!b) return;
          var f = b.detectLoginForm();
          if (!f || !f.hasLoginForm) return;
          if (f.usernameHandle) b.setValue(f.usernameHandle, ${ JSON.stringify(username) });
          if (f.passwordHandle) b.setValue(f.passwordHandle, ${ JSON.stringify(password) });
          // Auto-submit the form after filling
          setTimeout(function() {
            var pwEl = f.passwordField;
            var form = pwEl && pwEl.closest ? pwEl.closest('form') : null;
            if (form) {
              if (typeof form.requestSubmit === 'function') { form.requestSubmit(); }
              else { form.submit(); }
            } else {
              // No form — try clicking a submit button near the password field
              var container = pwEl ? pwEl.parentElement : document.body;
              for (var d = 0; d < 5 && container; d++) {
                var btn = container.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
                if (btn) { btn.click(); break; }
                container = container.parentElement;
              }
            }
          }, 200);
        })();
      `;
      view.webContents.executeJavaScript(script, true).catch(() => {});
      console.log(`[BrowserTabView] Vault autofill executed for ${ accountId }`);
    } catch (err) {
      console.error('[BrowserTabView] autofillVaultCredential error:', err);
    }
  }

  private attachListeners(tabId: string, view: WebContentsView, mainWindow: Electron.BrowserWindow): void {
    const wc = view.webContents;

    const sendState = () => {
      if (mainWindow.isDestroyed()) {
        return;
      }

      // If we're showing an error page (data: URL), report the original
      // failed URL so the address bar stays readable and retryable.
      const currentUrl = wc.getURL();
      const displayUrl = (currentUrl.startsWith('data:') && this.failedUrls.has(tabId))
        ? this.failedUrls.get(tabId)!
        : currentUrl;

      mainWindow.webContents.send('browser-tab-view:state-update', {
        tabId,
        url:        displayUrl,
        title:      wc.getTitle(),
        canGoBack:  wc.canGoBack(),
        canGoForward: wc.canGoForward(),
        isLoading:  wc.isLoading(),
      });
    };

    wc.on('did-navigate', sendState);
    wc.on('did-navigate-in-page', sendState);
    wc.on('page-title-updated', sendState);
    wc.on('did-start-loading', sendState);
    wc.on('did-stop-loading', sendState);

    // Inject a Shadow DOM context menu directly into the web page.
    // This renders inside the native WebContentsView layer so it's
    // always on top, and Shadow DOM isolates styles from the host page.
    wc.on('context-menu', (_event, params) => {
      if (mainWindow.isDestroyed()) return;

      const ctx = {
        tabId,
        x:                    params.x,
        y:                    params.y,
        selectionText:        params.selectionText || '',
        linkURL:              params.linkURL || '',
        srcURL:               params.srcURL || '',
        mediaType:            params.mediaType || '',
        isEditable:           params.isEditable,
        misspelledWord:       params.misspelledWord || '',
        dictionarySuggestions: params.dictionarySuggestions || [],
        canGoBack:            wc.canGoBack(),
        canGoForward:         wc.canGoForward(),
        pageURL:              wc.getURL(),
      };

      const script = buildContextMenuInjection(ctx);

      wc.executeJavaScript(script, true).catch((err) => {
        console.error('[BrowserTabView] context menu injection failed:', err);
      });
    });

    // Handle context menu actions from the injected Shadow DOM menu.
    // The menu calls __sullaBridgeEmit('context-menu-action', payload)
    // which arrives here via the preload's ipcRenderer.send().
    wc.ipc.on('browser-tab-view:bridge-event', (_event: Electron.IpcMainEvent, msg: { type: string; data: any }) => {
      if (msg.type !== 'context-menu-action') return;
      const { action, ...data } = msg.data || {};

      // Always remove the menu element first to avoid it interfering
      // with actions like select-all or DOM-based operations.
      wc.executeJavaScript(
        'var m=document.querySelector("sulla-context-menu");if(m)m.remove();', true,
      ).catch(() => {}).then(() => {
        switch (action) {
        case 'copy':              wc.copy(); break;
        case 'cut':               wc.cut(); break;
        case 'paste':             wc.paste(); break;
        case 'select-all':        wc.selectAll(); break;
        case 'undo':              wc.undo(); break;
        case 'redo':              wc.redo(); break;
        case 'go-back':           wc.goBack(); break;
        case 'go-forward':        wc.goForward(); break;
        case 'reload':            wc.reload(); break;
        case 'copy-image':        wc.copyImageAt(data.x ?? 0, data.y ?? 0); break;
        case 'inspect':           wc.inspectElement(data.x ?? 0, data.y ?? 0); break;
        case 'replace-selection':  wc.replace(data.text ?? ''); break;
        case 'add-to-dictionary': wc.session.addWordToSpellCheckerDictionary(data.word ?? ''); break;

        case 'copy-link':
        case 'copy-image-address': {
          const { clipboard } = require('electron') as typeof Electron;

          clipboard.writeText(data.url ?? '');
          break;
        }

        case 'save-image':
          if (data.srcURL) wc.downloadURL(data.srcURL);
          break;

        case 'view-source':
          wc.executeJavaScript('document.documentElement.outerHTML', true).then((html) => {
            const { BrowserWindow: BW } = require('electron');
            const win = new BW({ width: 800, height: 600, title: `Source: ${ wc.getURL() }` });

            win.loadURL(`data:text/plain;charset=utf-8,${ encodeURIComponent(html as string) }`);
          }).catch(() => {});
          break;

        // AI actions — forward to renderer
        case 'open-link-tab':
        case 'ai-ask':
        case 'ai-summarize':
        case 'ai-translate':
        case 'ai-explain-page':
        case 'ai-screenshot':
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('browser-context-menu:ai-action', { tabId, action, ...data });
          }
          break;

        default:
          console.warn(`[BrowserTabView] Unknown context menu action: ${ action }`);
        }
      });
    });

    // Chrome-style certificate error handling: show a warning page with an
    // "Advanced > Proceed" option instead of silently accepting or hard-blocking.
    wc.on('certificate-error', (event, url, error, certificate, callback) => {
      // If user previously accepted this host, proceed silently
      try {
        const host = new URL(url).host;

        if (this.acceptedCertHosts.has(host)) {
          event.preventDefault();
          callback(true);

          return;
        }
      } catch { /* fall through to warning page */ }

      // Block the load and show the certificate warning page
      callback(false);

      const certPage = buildCertErrorPage(url, error, certificate);

      wc.loadURL(`data:text/html;charset=utf-8,${ encodeURIComponent(certPage) }`).catch(() => {});
      this.failedUrls.set(tabId, url);
      console.warn(`[BrowserTabView] certificate-error tabId=${ tabId } error=${ error } url=${ url }`);
    });

    // Intercept the "Proceed anyway" action from the certificate warning page.
    // The page navigates to sulla://accept-cert which we catch here.
    wc.on('will-navigate', (event, url) => {
      if (url === 'sulla://accept-cert') {
        event.preventDefault();
        this.acceptCertificate(tabId);
      }
    });

    // Clear failed URL and stop retry polling on successful navigation.
    wc.on('did-navigate', () => {
      const url = wc.getURL();

      if (!url.startsWith('data:')) {
        this.failedUrls.delete(tabId);
        this.stopRetry(tabId);
      }
    });

    // ── Bridge events: forward sulla:* events to renderer for WebviewHostBridge ──
    // The guest preload sends events via ipcRenderer.send('browser-tab-view:bridge-event').
    // Forward bridge lifecycle events (sulla:injected, sulla:routeChanged, sulla:domChange,
    // sulla:click, sulla:dialog, sulla:pageContent, sulla:contentAdded) to the renderer
    // so the WebviewHostBridge state machine can transition properly.
    wc.ipc.on('browser-tab-view:bridge-event', (_event: Electron.IpcMainEvent, msg: { type: string; data: any }) => {
      if (!msg?.type?.startsWith('sulla:')) return;
      // Skip vault and context-menu events — they're handled by dedicated handlers below.
      if (msg.type.startsWith('sulla:vault:') || msg.type === 'context-menu-action') return;

      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-tab-view:bridge-event', { tabId, ...msg });
      }
    });

    // Forward dom-ready to the renderer so the bridge adapter can notify WebviewHostBridge.
    wc.on('dom-ready', () => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('browser-tab-view:dom-ready', { tabId });
      }
    });

    // ── Vault: handle bridge events from guest pages ──
    // Route vault-related events from the guest bridge to the renderer.
    // Uses wc.ipc.on() which receives the payload as { type, data } directly,
    // matching the preload's ipcRenderer.send('browser-tab-view:bridge-event', { type, data }).
    wc.ipc.on('browser-tab-view:bridge-event', (_event: Electron.IpcMainEvent, msg: { type: string; data: any }) => {
      if (!msg?.type?.startsWith('sulla:vault:')) return;

      const { type, data } = msg;

      if (type === 'sulla:vault:getMatches') {
        // Query vault for matching accounts and send them back to the page
        this.sendVaultMatchesToPage(tabId, data.origin);
      }

      if (type === 'sulla:vault:credentialsPending') {
        this.setPendingCredentials(tabId, data.origin, data.username, data.password, data.title);
      }

      if (type === 'sulla:vault:credentialsCaptured') {
        // User clicked "Save" or "Update" — retrieve password from pending store
        const pending = this.pendingCredentials.get(tabId);

        if (pending) {
          if (pending.existingAccountId) {
            // Update existing account's password
            this.updateVaultPassword(pending.existingAccountId, pending.password);
          } else {
            // Save as new account
            this.saveVaultCredential(pending.origin, pending.username, pending.password, pending.pageTitle);
          }
          this.clearPendingCredentials(tabId);
        }
      }

      if (type === 'sulla:vault:credentialsDismissed') {
        this.clearPendingCredentials(tabId);
      }

      if (type === 'sulla:vault:autofillRequest') {
        // User clicked an account in the dropdown — autofill the form
        this.autofillVaultCredential(tabId, data.accountId);
      }

      if (type === 'sulla:vault:loginFormDetected') {
        // Login form appeared — send matching accounts to page
        this.sendVaultMatchesToPage(tabId, data.origin);
      }
    });

    // Also check vault on successful navigation (for pages where the login
    // form is already rendered in the initial HTML, not SPA-injected)
    wc.on('did-stop-loading', () => {
      const url = wc.getURL();
      if (url.startsWith('data:') || url === 'about:blank') return;
      try {
        const origin = new URL(url).origin;
        this.checkVaultForAutofill(tabId, origin, mainWindow);
        // Re-show save toast if there are pending credentials for this tab
        const pending = this.pendingCredentials.get(tabId);
        if (pending) {
          this.pushSaveToastToPage(tabId, !!pending.existingAccountId);
        }
      } catch { /* invalid URL */ }
    });

    // Show a Chrome-style error page when a site can't be reached,
    // then silently poll the URL and auto-reload when it becomes available.
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 = ABORTED (user cancelled / navigated away) — don't show error
      if (errorCode === -3) return;

      // Remember the original URL so the address bar stays readable
      this.failedUrls.set(tabId, validatedURL);

      const errorPage = buildErrorPage(validatedURL, errorCode, errorDescription);

      wc.loadURL(`data:text/html;charset=utf-8,${ encodeURIComponent(errorPage) }`).catch(() => {});
      console.warn(`[BrowserTabView] did-fail-load tabId=${ tabId } code=${ errorCode } desc=${ errorDescription } url=${ validatedURL }`);

      // Start polling — check every 5 seconds if the site is back up
      this.startRetry(tabId, validatedURL);
    });
  }
}

/**
 * Generates a Chrome-style error page.
 */
function buildErrorPage(url: string, errorCode: number, errorDescription: string): string {
  // Map common Chromium network error codes to user-friendly messages
  const messages: Record<number, { title: string; detail: string }> = {
    [-2]:   { title: 'Network error',              detail: 'A network error occurred.' },
    [-6]:   { title: 'File not found',             detail: 'The file could not be found.' },
    [-7]:   { title: 'Too many redirects',         detail: 'The page redirected too many times.' },
    [-15]:  { title: 'Connection reset',           detail: 'The connection was reset.' },
    [-21]:  { title: 'Network changed',            detail: 'A network change was detected.' },
    [-100]: { title: 'Connection closed',           detail: 'The connection was closed unexpectedly.' },
    [-101]: { title: 'Connection reset',           detail: 'The connection was reset.' },
    [-102]: { title: 'Connection refused',         detail: 'The server refused the connection.' },
    [-103]: { title: 'Connection failed',          detail: 'Could not connect to the server.' },
    [-104]: { title: 'Connection failed',          detail: 'Could not connect to the server.' },
    [-105]: { title: 'Name not resolved',          detail: 'The server\'s DNS address could not be found.' },
    [-106]: { title: 'Internet disconnected',      detail: 'You are not connected to the internet.' },
    [-109]: { title: 'Address unreachable',        detail: 'The server address is unreachable.' },
    [-110]: { title: 'SSL protocol error',         detail: 'An SSL protocol error occurred.' },
    [-112]: { title: 'Connection timed out',       detail: 'The connection to the server timed out.' },
    [-118]: { title: 'Connection timed out',       detail: 'The connection to the server timed out.' },
    [-130]: { title: 'Proxy connection failed',    detail: 'Could not connect through the proxy server.' },
    [-200]: { title: 'Certificate error',          detail: 'The server\'s certificate is not trusted.' },
    [-201]: { title: 'Certificate date invalid',   detail: 'The server\'s certificate has expired or is not yet valid.' },
    [-202]: { title: 'Certificate authority invalid', detail: 'The server\'s certificate authority is not trusted.' },
  };

  const info = messages[errorCode] || { title: 'This page can\u2019t be reached', detail: errorDescription || 'An unexpected error occurred.' };

  let hostname = '';

  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${ info.title }</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 40px;
    }
    .error-container {
      max-width: 480px;
      text-align: center;
    }
    .error-icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      border-radius: 50%;
      background: #161b22;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #e6edf3;
    }
    .hostname {
      font-size: 14px;
      color: #8b949e;
      margin-bottom: 16px;
      word-break: break-all;
    }
    .detail {
      font-size: 14px;
      color: #8b949e;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .error-code {
      font-size: 12px;
      color: #484f58;
      font-family: monospace;
    }
    .retry-btn {
      display: inline-block;
      padding: 8px 20px;
      border-radius: 6px;
      border: 1px solid #30363d;
      background: #21262d;
      color: #c9d1d9;
      font-size: 14px;
      cursor: pointer;
      margin-bottom: 16px;
      text-decoration: none;
    }
    .retry-btn:hover { background: #30363d; }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-icon">\u26A0\uFE0F</div>
    <h1>${ info.title }</h1>
    <p class="hostname">${ hostname }</p>
    <p class="detail">${ info.detail }</p>
    <a class="retry-btn" href="${ url }">Reload</a>
    <p class="error-code">ERR_${ errorDescription.replace(/^net::ERR_/i, '').replace(/\s+/g, '_').toUpperCase() } (${ errorCode })</p>
  </div>
</body>
</html>`;
}

/**
 * Generates a Chrome-style certificate warning page with Advanced / Proceed option.
 */
function buildCertErrorPage(url: string, error: string, certificate: Electron.Certificate): string {
  let hostname = '';

  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = url;
  }

  const issuer = certificate.issuerName || 'Unknown';
  const subject = certificate.subjectName || hostname;
  const validFrom = certificate.validStart ? new Date(certificate.validStart * 1000).toLocaleDateString() : 'Unknown';
  const validTo = certificate.validExpiry ? new Date(certificate.validExpiry * 1000).toLocaleDateString() : 'Unknown';
  const fingerprint = certificate.fingerprint || 'Unknown';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Your connection is not private</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 40px;
    }
    .error-container { max-width: 560px; text-align: center; }
    .error-icon {
      width: 72px; height: 72px; margin: 0 auto 24px;
      border-radius: 50%; background: #3b1d1d;
      display: flex; align-items: center; justify-content: center;
      font-size: 32px;
    }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 8px; color: #f85149; }
    .hostname { font-size: 14px; color: #8b949e; margin-bottom: 16px; word-break: break-all; }
    .detail { font-size: 14px; color: #8b949e; line-height: 1.6; margin-bottom: 24px; text-align: left; }
    .btn {
      display: inline-block; padding: 8px 20px; border-radius: 6px;
      border: 1px solid #30363d; background: #21262d; color: #c9d1d9;
      font-size: 14px; cursor: pointer; margin: 4px; text-decoration: none;
    }
    .btn:hover { background: #30363d; }
    .btn-proceed { border-color: #f8514966; color: #f85149; }
    .btn-proceed:hover { background: #3b1d1d; }
    .advanced-toggle {
      font-size: 13px; color: #58a6ff; cursor: pointer;
      margin-top: 16px; display: inline-block; background: none; border: none;
    }
    .advanced-toggle:hover { text-decoration: underline; }
    .advanced-section {
      display: none; margin-top: 20px; text-align: left;
      background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px;
    }
    .advanced-section.open { display: block; }
    .cert-table { width: 100%; font-size: 13px; }
    .cert-table td { padding: 4px 0; vertical-align: top; }
    .cert-table td:first-child { color: #8b949e; width: 110px; white-space: nowrap; }
    .cert-table td:last-child { color: #c9d1d9; word-break: break-all; font-family: monospace; font-size: 12px; }
    .proceed-warning {
      font-size: 13px; color: #8b949e; margin: 16px 0 12px;
      line-height: 1.5; text-align: left;
    }
    .error-code { font-size: 12px; color: #484f58; font-family: monospace; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-icon">\uD83D\uDD12</div>
    <h1>Your connection is not private</h1>
    <p class="hostname">${ hostname }</p>
    <p class="detail">
      Attackers might be trying to steal your information from <strong>${ hostname }</strong>
      (for example, passwords, messages, or credit cards). The server's security certificate
      is not trusted by this application.
    </p>
    <a class="btn" href="${ url }">Back to safety</a>
    <button class="advanced-toggle" onclick="document.getElementById('adv').classList.toggle('open')">
      Advanced
    </button>
    <div id="adv" class="advanced-section">
      <table class="cert-table">
        <tr><td>Subject</td><td>${ subject }</td></tr>
        <tr><td>Issuer</td><td>${ issuer }</td></tr>
        <tr><td>Valid from</td><td>${ validFrom }</td></tr>
        <tr><td>Valid until</td><td>${ validTo }</td></tr>
        <tr><td>Fingerprint</td><td>${ fingerprint }</td></tr>
        <tr><td>Error</td><td>${ error }</td></tr>
      </table>
      <p class="proceed-warning">
        This server could not prove that it is <strong>${ hostname }</strong>; its security
        certificate is not trusted. Proceeding may expose your data to third parties.
      </p>
      <a class="btn btn-proceed" href="sulla://accept-cert">Proceed to ${ hostname } (unsafe)</a>
    </div>
    <p class="error-code">NET::${ error.toUpperCase().replace(/\s+/g, '_') }</p>
  </div>
</body>
</html>`;
}
