import path from 'path';

import Electron, { WebContentsView } from 'electron';

import { SullaWebRequestFixer } from '@pkg/SullaWebRequestFixer';
import { tabRegistry } from '@pkg/main/browserTabs/TabRegistry';
import { BrowserPermissionPolicy, SitePermissionStore, originOf } from '@pkg/main/browserTabs/browserPermissions';
import { BROWSER_SESSION_PARTITION, getBrowserSession } from '@pkg/main/browserTabs/browserSession';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import { safeSend } from '@pkg/utils/safeSend';
import { getWindow, openUrlInApp } from '@pkg/window';
import { buildContextMenuInjection } from '@pkg/window/browserContextMenu';

const console = Logging.sulla;

interface VaultAccountMatch {
  accountId: string;
  username:  string;
  origin:    string;
}

interface PendingCredential {
  origin:             string;
  username:           string;
  password:           string;
  timer:              ReturnType<typeof setTimeout>;
  pageTitle?:         string;
  existingAccountId?: string;
  frame?:             Electron.WebFrameMain | null;
}

const VAULT_INDEX_TTL_MS = 30_000;

/** How long a native right-click keeps the injected context menu's actions live. */
const CONTEXT_MENU_ARM_MS = 2 * 60_000;

/**
 * The origin a guest frame really has, as reported by the browser process —
 * never the origin a page claims in its IPC payload. Returns null for opaque
 * or non-web origins, which never get vault access.
 */
export function trustedFrameOrigin(frame: Electron.WebFrameMain | null | undefined): string | null {
  try {
    if (!frame || (frame as any).detached) return null;
    const origin = frame.origin;
    if (!origin || origin === 'null') return null;
    const { protocol } = new URL(origin);

    return protocol === 'https:' || protocol === 'http:' ? origin : null;
  } catch {
    return null;
  }
}

interface ViewHealth {
  captureFailures: number;
  stuckScrolls:    number;
  probeInFlight:   boolean;
  recovering:      boolean;
  lastRecoveryAt:  number;
  recoveryStage:   'reattached' | 'recreated' | null;
}

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
  /**
   * SINGLE SOURCE OF TRUTH: the tabId of the view currently focused by the
   * user, or `null` when no browser tab should be visible (chat mode, login
   * overlay, etc.). Everything else reconciles to this value via
   * `reconcileVisibility()`. Callers NEVER mutate child-view attachments
   * directly — they set `focusedTabId` through `setFocusedTab()` and the
   * manager reconciles. The renderer funnels every visibility decision
   * through the `browser-tab-view:focus` IPC, which maps 1:1 to
   * `setFocusedTab`. ChromeApiService does the same for programmatic
   * tab activation.
   */
  private focusedTabId:    string | null = null;
  /**
   * Latest bounds the renderer has reported for each tab. Always current —
   * the renderer's ResizeObserver updates this continuously regardless of
   * focus state. Only the focused tab's bounds are actually pushed to the
   * native view (in `reconcileVisibility`); the rest are cached so that
   * when focus shifts, we know exactly where to place the newly-focused
   * view without a flash of stale coordinates.
   */
  private latestBounds = new Map<string, Electron.Rectangle>();
  private failedUrls = new Map<string, string>(); // tabId → original URL that failed
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Last time each tab was focused or driven programmatically (agent tools,
   * input/screenshot IPC). Parked tabs idle longer than IDLE_SLEEP_MS are put
   * to sleep; see sleepIdleViews / wakeView.
   */
  private lastActiveAt = new Map<string, number>();
  private sleepingTabs = new Set<string>();
  private viewHealth = new Map<string, ViewHealth>();
  private healthMonitor:   ReturnType<typeof setInterval> | null = null;
  private acceptedCertHosts = new Set<string>(); // hosts where user clicked "Proceed"
  /** Credentials captured but not yet saved — keyed by tabId, auto-expires after 90s */
  private pendingCredentials = new Map<string, PendingCredential>();
  /**
   * origin → saved website accounts. Built in one pass over the vault and
   * reused for VAULT_INDEX_TTL_MS so a login form doesn't cost N+1 vault
   * queries per page load. Invalidated whenever this manager writes the vault.
   */
  private vaultIndex: { builtAt: number; byOrigin: Map<string, VaultAccountMatch[]> } | null = null;
  private vaultIndexBuild: Promise<Map<string, VaultAccountMatch[]>> | null = null;
  private sessionInitialised = false;
  /** Subscribers notified for every tab view created (see onViewCreated). */
  private viewCreatedListeners = new Set<(tabId: string, wc: Electron.WebContents) => void>();
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
    const sess = getBrowserSession();

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

      // Promote session cookies to persistent ONLY for localhost services.
      // External sites (github.com, etc.) rely on persist:sulla-browser which
      // already persists all cookies to disk — re-setting them causes CSRF
      // validation failures because the immediate overwrite races with the
      // site's own session management (e.g. GitHub authenticity_token check).
      sess.cookies.on('changed', (_event, cookie, _cause, removed) => {
        if (removed) return;
        // Only promote session cookies (those without an expiry)
        if (cookie.expirationDate) return;

        // Only promote localhost service cookies — persist: partition already
        // handles persistence for external sites without us touching the cookie.
        const rawDomain = (cookie.domain || '').replace(/^\./, '');
        const isLocal = rawDomain === 'localhost' || rawDomain === '127.0.0.1' || rawDomain === '0.0.0.0';
        if (!isLocal) return;

        const url = `http${ cookie.secure ? 's' : '' }://${ rawDomain }${ cookie.path || '/' }`;

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

      this.installPermissionPolicy(sess);

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
      console.log('[BrowserTabView] Session initialised:', BROWSER_SESSION_PARTITION);
    }

    return sess;
  }

  /**
   * Site permissions (camera, mic, location, clipboard read, …). Without a
   * handler Electron silently grants every request to every website. See
   * browserPermissions.ts for the policy.
   */
  private installPermissionPolicy(sess: Electron.Session): void {
    let storePath: string | null = null;
    try {
      storePath = path.join(Electron.app.getPath('userData'), 'browser-site-permissions.json');
    } catch { /* tests / app not ready — keep decisions in memory */ }

    const policy = new BrowserPermissionPolicy(new SitePermissionStore(storePath), async(origin, description) => {
      const parent = getWindow('main-agent');
      const options: Electron.MessageBoxOptions = {
        type:      'question',
        buttons:   ['Block', 'Allow'],
        defaultId: 0,
        cancelId:  0,
        message:   `${ new URL(origin).host } wants to ${ description }`,
        detail:    'Sulla will remember your choice for this site.',
      };
      const { response } = parent && !parent.isDestroyed()
        ? await Electron.dialog.showMessageBox(parent, options)
        : await Electron.dialog.showMessageBox(options);

      return response === 1;
    });

    const isUserVisible = (wc: Electron.WebContents): boolean => {
      if (this.focusedTabId && this.views.get(this.focusedTabId)?.webContents === wc) return true;
      // Popup windows (OAuth, "sized" window.open) are real, visible windows.
      try {
        return !!Electron.BrowserWindow.fromWebContents(wc);
      } catch {
        return false;
      }
    };

    sess.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      return policy.check(permission, originOf(requestingOrigin) ?? originOf((details as any)?.requestingUrl), details as any);
    });
    sess.setPermissionRequestHandler((wc, permission, callback, details) => {
      const origin = originOf((details as any)?.requestingUrl) ?? originOf(wc.getURL());

      policy.request({ permission, origin, details: details as any, userVisible: isUserVisible(wc) })
        .then(callback, () => callback(false));
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  createView(tabId: string, url: string, bounds: Electron.Rectangle): void {
    // Idempotent: if the view already exists, just navigate (if URL changed)
    // and cache the new bounds. Actual attach/visibility state is driven
    // exclusively by `focusedTabId` via reconcileVisibility.
    const existing = this.views.get(tabId);
    if (existing) {
      if (existing.webContents.getURL() !== url) {
        existing.webContents.loadURL(url).catch(() => {});
      }
      this.latestBounds.set(tabId, bounds);
      if (this.focusedTabId === tabId) {
        existing.setBounds(bounds);
      }
      return;
    }

    const mainWindow = getWindow('main-agent');

    if (!mainWindow) {
      throw new Error('[BrowserTabView] Cannot create view — main window not found');
    }

    // Make sure shared session is ready
    const browserSession = this.ensureSession();

    const view = new WebContentsView({
      webPreferences: {
        // Same-origin policy stays ON. These tabs hold the user's real logged-in
        // sessions; with webSecurity off any page could read any other site's
        // data (fetch with cookies, no CORS) and load mixed content.
        webSecurity:          true,
        contextIsolation:     false,
        nodeIntegration:      false,
        session:              browserSession,
        // Set this before the renderer is created. Electron documents that
        // backgroundThrottling also controls the Page Visibility API; setting
        // it after construction can leave the initial document hidden.
        backgroundThrottling: false,
      },
    });

    if (view.webContents.session !== browserSession) {
      throw new Error('[BrowserTabView] WebContentsView did not adopt the shared browser session');
    }

    // Disable background throttling so the Chromium renderer stays awake and
    // the compositor keeps producing frames even when the view is parked
    // off-screen. Without this, capturePage returns empty NativeImage on
    // brand-new views that have never been in a visible position.
    view.webContents.setBackgroundThrottling(false);

    view.setBounds(bounds);
    this.views.set(tabId, view);
    this.latestBounds.set(tabId, bounds);
    this.viewHealth.set(tabId, this.newViewHealth());
    this.lastActiveAt.set(tabId, Date.now());
    this.startHealthMonitor();

    // Forward guest warnings/errors to the main log so preload / guest bridge
    // failures are visible. info/debug chatter from arbitrary websites is
    // dropped: it is noise, costs a synchronous log write per line, and can
    // carry page data we have no business persisting.
    view.webContents.on('console-message', (event) => {
      const { level, message, lineNumber, sourceId } = event;
      if (level !== 'warning' && level !== 'error') return;
      console.log(`[BrowserTabView:${ tabId }] [${ level }] ${ String(message).slice(0, 500) } (${ sourceId }:${ lineNumber })`);
    });

    // Wire up event listeners that forward state to the renderer
    this.attachListeners(tabId, view, mainWindow);
    for (const listener of this.viewCreatedListeners) {
      try {
        listener(tabId, view.webContents);
      } catch (err) {
        console.warn(`[BrowserTabView] view-created listener failed tabId=${ tabId }:`, err);
      }
    }

    view.webContents.loadURL(url).catch((err) => {
      console.error(`[BrowserTabView] Failed to load URL for tabId=${ tabId }:`, err);
    });

    // Run reconciliation unconditionally so the new view lands in the
    // correct state: attached at top+real bounds if it's the focused tab,
    // attached off-screen if not. Always attaching (even for background
    // tabs) is what keeps the compositor alive so agent-initiated captures
    // of never-viewed tabs still work.
    this.reconcileVisibility();

    console.log(`[BrowserTabView] Created view tabId=${ tabId } url=${ redactUrl(url) }`);
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

    this.stopRetry(tabId);
    (view.webContents as any).close?.();
    this.views.delete(tabId);
    this.viewHealth.delete(tabId);
    this.latestBounds.delete(tabId);
    this.failedUrls.delete(tabId);
    this.lastActiveAt.delete(tabId);
    this.sleepingTabs.delete(tabId);
    this.clearPendingCredentials(tabId);
    if (this.focusedTabId === tabId) {
      this.focusedTabId = null;
      // No reconcile needed — the view is gone; detach already happened above.
    }
    if (this.views.size === 0 && this.healthMonitor) {
      clearInterval(this.healthMonitor);
      this.healthMonitor = null;
    }
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
    this.getWebContents(tabId)?.navigationHistory.goBack();
  }

  goForward(tabId: string): void {
    this.getWebContents(tabId)?.navigationHistory.goForward();
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

  /**
   * Cache the renderer's latest layout rectangle for a tab. Bounds are
   * tracked for every tab whether focused or not — the renderer's
   * ResizeObserver streams them continuously. Only the focused tab's
   * bounds get pushed to the native view; unfocused tabs have no
   * on-screen presence to position.
   */
  setBounds(tabId: string, bounds: Electron.Rectangle): void {
    const view = this.views.get(tabId);
    if (!view) return;
    this.latestBounds.set(tabId, bounds);
    if (this.focusedTabId === tabId) {
      view.setBounds(bounds);
    }
  }

  /**
   * THE authoritative visibility mutator. Pass `tabId` to make that tab
   * the focused (visible) one, or `null` to detach all browser tabs
   * (e.g. when the user switches to chat mode or the login overlay
   * comes up). Every caller — renderer, chrome-api, login overlay —
   * funnels through here. `reconcileVisibility` does the mechanical work.
   */
  setFocusedTab(tabId: string | null, clearOnlyIfFocusedTabId?: string): void {
    if (tabId === null && clearOnlyIfFocusedTabId && this.focusedTabId !== clearOnlyIfFocusedTabId) {
      console.log(`[BrowserTabView] ignored stale focus clear from ${ clearOnlyIfFocusedTabId }; focused=${ this.focusedTabId ?? '(none)' }`);
      return;
    }
    if (this.focusedTabId === tabId) return;
    console.log(`[BrowserTabView] setFocusedTab ${ this.focusedTabId ?? '(none)' } → ${ tabId ?? '(none)' }`);
    if (this.focusedTabId) this.lastActiveAt.set(this.focusedTabId, Date.now());
    this.focusedTabId = tabId;
    if (tabId) this.viewHealth.set(tabId, this.newViewHealth());
    this.reconcileVisibility();
  }

  /**
   * Observe every tab view as it is created — e.g. ChromeApiService attaches
   * chrome.webNavigation / history listeners here. Existing views are
   * replayed so late subscribers miss nothing. Returns an unsubscribe fn.
   */
  onViewCreated(listener: (tabId: string, wc: Electron.WebContents) => void): () => void {
    this.viewCreatedListeners.add(listener);
    for (const [tabId, view] of this.views) listener(tabId, view.webContents);

    return () => this.viewCreatedListeners.delete(listener);
  }

  getFocusedTab(): string | null {
    return this.focusedTabId;
  }

  /**
   * Bring the window's child-view list into agreement with
   * `focusedTabId`:
   *   - The focused view is attached at the top of z-order at its latest
   *     bounds (so it overlays the Vue chat renderer).
   *   - Every other view stays attached but parked off-screen at
   *     negative x-coordinates, with a valid non-zero size so the
   *     compositor keeps producing frames. This combines with
   *     `capturePage({stayHidden: true})` in GuestBridge to guarantee
   *     screenshots work regardless of focus — `stayHidden` forces paint,
   *     off-screen bounds hide it from the user, and the view never
   *     leaves the window's view tree (which is what was breaking
   *     capture for fully-detached views).
   *
   * This is the ONLY place in the codebase that mutates
   * contentView.addChildView / removeChildView / setBounds for tab views.
   */
  private reconcileVisibility(): void {
    const mainWindow = getWindow('main-agent');
    if (!mainWindow) return;

    // Park unfocused views just off-screen to the left: x = -(width + margin)
    // so the right edge sits PARK_MARGIN pixels past the viewport's left edge.
    // Must be dynamic — a hardcoded PARK_X (previously -1300) leaves the right
    // portion of wide views visible on wide displays (e.g. 2958px wide screen,
    // width≥1400px view → right edge at x ≥ 100, visibly bleeding through).
    // Margin stays small so the view remains within Chromium's tile-cache
    // buffer zone; -100_000 kills tile generation and capturePage returns
    // empty NativeImages indefinitely.
    const PARK_MARGIN = 100;

    for (const [tabId, view] of this.views) {
      if (tabId === this.focusedTabId) {
        // Explicitly clear any native hidden state before attaching/promoting
        // the focused view. Parked views remain drawable off-screen for agent
        // capture, while focused pages report visibilityState=visible.
        view.setVisible(true);
        view.webContents.setBackgroundThrottling(false);
        this.sleepingTabs.delete(tabId);
        this.lastActiveAt.set(tabId, Date.now());
        const bounds = this.latestBounds.get(tabId);
        if (bounds) view.setBounds(bounds);
        try {
          // addChildView on an attached view promotes it to top of z-order;
          // on a detached view, re-attaches at top. Either way: top.
          mainWindow.contentView.addChildView(view);
        } catch (err) {
          console.warn(`[BrowserTabView] reconcile attach failed tabId=${ tabId }:`, err);
        }
      } else {
        // Park off-screen. Keep the view attached so its compositor stays
        // alive — detached WebContentsViews stop painting in Electron 40
        // even with stayHidden, which breaks capturePage.
        const last = this.latestBounds.get(tabId);
        const width = Math.max(last?.width ?? 1280, 1);
        const parked: Electron.Rectangle = {
          x:      -(width + PARK_MARGIN),
          y:      last?.y ?? 0,
          width,
          height: Math.max(last?.height ?? 800, 1),
        };
        view.setBounds(parked);
        try {
          // Ensure still attached (no-op if already attached). Index 0 puts
          // it at the bottom of z-order so focused tab overlays cleanly.
          mainWindow.contentView.addChildView(view, 0);
        } catch (err) {
          console.warn(`[BrowserTabView] reconcile park failed tabId=${ tabId }:`, err);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Compositor / input-routing wedge recovery
  // ---------------------------------------------------------------------------

  private static readonly HEALTH_PROBE_INTERVAL_MS = 8_000;
  private static readonly HEALTH_PROBE_TIMEOUT_MS = 3_000;
  private static readonly CAPTURE_FAILURE_THRESHOLD = 2;
  private static readonly STUCK_SCROLL_THRESHOLD = 3;
  private static readonly RECOVERY_COOLDOWN_MS = 1_500;

  private newViewHealth(): ViewHealth {
    return {
      captureFailures: 0,
      stuckScrolls:    0,
      probeInFlight:   false,
      recovering:      false,
      lastRecoveryAt:  0,
      recoveryStage:   null,
    };
  }

  private startHealthMonitor(): void {
    if (this.healthMonitor) return;

    this.healthMonitor = setInterval(() => {
      this.sleepIdleViews();
      this.probeFocusedView().catch((err) => {
        console.warn('[BrowserTabView] focused-view health probe failed:', err);
      });
    }, BrowserTabViewManager.HEALTH_PROBE_INTERVAL_MS);
    this.healthMonitor.unref?.();
  }

  // ---------------------------------------------------------------------------
  // Background-tab sleep
  // ---------------------------------------------------------------------------

  /** A parked tab nobody has focused or driven for this long is put to sleep. */
  static readonly IDLE_SLEEP_MS = 2 * 60_000;

  /**
   * Parked tabs stay attached off-screen and marked visible so agent tools
   * can capture and drive them instantly — but that also means every hidden
   * tab ran at full foreground speed forever (rAF, video, timers), burning
   * CPU/GPU/battery for pages nobody is looking at.
   *
   * After IDLE_SLEEP_MS without focus or programmatic use, a parked tab is
   * hidden (page sees visibilitychange → hidden) and background-throttled,
   * which is exactly how Chrome treats background tabs. Tabs that are
   * loading or playing audio are left alone. Any programmatic use goes
   * through wakeView() first, restoring the proven attached+visible state.
   */
  sleepIdleViews(now = Date.now()): void {
    for (const [tabId, view] of this.views) {
      if (tabId === this.focusedTabId || this.sleepingTabs.has(tabId)) continue;
      const wc = view.webContents;
      try {
        if (wc.isDestroyed() || wc.isLoading() || wc.isCurrentlyAudible()) continue;
      } catch {
        continue;
      }
      if (now - (this.lastActiveAt.get(tabId) ?? 0) < BrowserTabViewManager.IDLE_SLEEP_MS) continue;

      try {
        view.setVisible(false);
        wc.setBackgroundThrottling(true);
        this.sleepingTabs.add(tabId);
      } catch (err) {
        console.warn(`[BrowserTabView] sleep failed tabId=${ tabId }:`, err);
      }
    }
  }

  /**
   * Mark a tab as in active programmatic use and, if it was asleep, restore
   * it to the awake parked state (visible to the compositor, unthrottled) so
   * screenshots, scripting and input behave exactly as before. Call before
   * driving a tab that may not be focused.
   */
  wakeView(tabId: string): void {
    const view = this.views.get(tabId);
    if (!view) return;
    this.lastActiveAt.set(tabId, Date.now());
    if (!this.sleepingTabs.delete(tabId)) return;
    try {
      view.setVisible(true);
      view.webContents.setBackgroundThrottling(false);
    } catch (err) {
      console.warn(`[BrowserTabView] wake failed tabId=${ tabId }:`, err);
    }
  }

  isSleeping(tabId: string): boolean {
    return this.sleepingTabs.has(tabId);
  }

  /**
   * capturePage is intentionally used here rather than the screenshot tool's
   * CDP path: an empty NativeImage is the known signal for the detached-view
   * compositor wedge. Probe only the visible, settled view to avoid waking
   * every parked tab or treating navigation as a failure.
   */
  private async probeFocusedView(): Promise<void> {
    const tabId = this.focusedTabId;
    if (!tabId) return;

    const view = this.views.get(tabId);
    const health = this.viewHealth.get(tabId);

    if (!view || !health || health.probeInFlight || health.recovering) return;
    if (view.webContents.isDestroyed() || view.webContents.isLoading()) return;

    const bounds = this.latestBounds.get(tabId);
    if (!bounds || bounds.width < 1 || bounds.height < 1) return;

    // Nothing is on screen to be wedged while the window is hidden or
    // minimized — skip the GPU readback entirely.
    const mainWindow = getWindow('main-agent');
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return;

    // The wedge signal is "no compositor frame" (empty NativeImage), which a
    // small region reports just as well as a full-page capture — at a tiny
    // fraction of the readback cost every probe interval.
    const probeRect = {
      x:      0,
      y:      0,
      width:  Math.min(64, Math.max(1, Math.floor(bounds.width))),
      height: Math.min(64, Math.max(1, Math.floor(bounds.height))),
    };

    health.probeInFlight = true;
    try {
      const image = await Promise.race([
        view.webContents.capturePage(probeRect, { stayHidden: true, stayAwake: true }),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error('capturePage health probe timed out')),
          BrowserTabViewManager.HEALTH_PROBE_TIMEOUT_MS,
        )),
      ]);

      if (this.views.get(tabId) !== view || this.focusedTabId !== tabId) return;

      if (image.isEmpty()) {
        await this.recordCaptureFailure(tabId, 'empty NativeImage');
      } else {
        health.captureFailures = 0;
      }
    } catch (err) {
      if (this.views.get(tabId) !== view || this.focusedTabId !== tabId) return;
      const reason = err instanceof Error ? err.message : String(err);

      await this.recordCaptureFailure(tabId, reason);
    } finally {
      health.probeInFlight = false;
    }
  }

  private async recordCaptureFailure(tabId: string, reason: string): Promise<void> {
    const health = this.viewHealth.get(tabId);
    if (!health) return;

    health.captureFailures++;
    if (health.captureFailures < BrowserTabViewManager.CAPTURE_FAILURE_THRESHOLD) return;

    health.captureFailures = 0;
    await this.recoverWedgedView(tabId, `capture watchdog: ${ reason }`);
  }

  private handleScrollHeartbeat(tabId: string, moved: boolean): void {
    if (tabId !== this.focusedTabId) return;

    const health = this.viewHealth.get(tabId);
    if (!health || health.recovering) return;

    if (moved) {
      health.stuckScrolls = 0;
      health.recoveryStage = null;
      return;
    }

    health.stuckScrolls++;
    if (health.stuckScrolls < BrowserTabViewManager.STUCK_SCROLL_THRESHOLD) return;

    health.stuckScrolls = 0;
    this.recoverWedgedView(tabId, 'wheel events reached a scrollable DOM target without scroll movement').catch((err) => {
      console.warn(`[BrowserTabView] scroll-input recovery failed tabId=${ tabId }:`, err);
    });
  }

  private async recoverWedgedView(tabId: string, reason: string): Promise<void> {
    const health = this.viewHealth.get(tabId);
    const view = this.views.get(tabId);
    const mainWindow = getWindow('main-agent');

    if (!health || !view || !mainWindow || tabId !== this.focusedTabId) return;
    if (health.recovering || Date.now() - health.lastRecoveryAt < BrowserTabViewManager.RECOVERY_COOLDOWN_MS) return;

    health.recovering = true;
    health.lastRecoveryAt = Date.now();
    const shouldRecreate = health.recoveryStage === 'reattached';
    const action = shouldRecreate ? 'recreate-preserving-webContents' : 'detach-reattach';

    console.warn(`[BrowserTabView] wedge recovery fired tabId=${ tabId } action=${ action } reason=${ reason }`);

    try {
      mainWindow.contentView.removeChildView(view);
      await new Promise(resolve => setTimeout(resolve, 50));

      if (this.views.get(tabId) !== view || this.focusedTabId !== tabId) return;

      const bounds = this.latestBounds.get(tabId);
      if (shouldRecreate) {
        const replacement = new WebContentsView({ webContents: view.webContents });

        replacement.webContents.setBackgroundThrottling(false);
        if (bounds) replacement.setBounds(bounds);
        this.views.set(tabId, replacement);
        mainWindow.contentView.addChildView(replacement);
        health.recoveryStage = 'recreated';
      } else {
        if (bounds) view.setBounds(bounds);
        mainWindow.contentView.addChildView(view);
        health.recoveryStage = 'reattached';
      }

      this.views.get(tabId)?.webContents.focus();
      health.captureFailures = 0;
      health.stuckScrolls = 0;
    } catch (err) {
      console.warn(`[BrowserTabView] wedge recovery failed tabId=${ tabId } action=${ action }:`, err);
      this.reconcileVisibility();
    } finally {
      health.recovering = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Scripting
  // ---------------------------------------------------------------------------

  async executeJavaScript(tabId: string, code: string): Promise<unknown> {
    const wc = this.getWebContents(tabId);

    if (!wc) {
      return undefined;
    }
    this.wakeView(tabId);

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
  private static readonly RETRY_MAX_INTERVAL_MS = 60_000;

  /**
   * Silently poll a URL that failed to load and reload the page once the
   * server answers (any HTTP status). Polls back off from 5s to 60s so a
   * tab left on a dead dev server doesn't probe it every 5s forever.
   */
  private startRetry(tabId: string, url: string): void {
    this.stopRetry(tabId); // clear any existing timer

    const attempt = (delayMs: number) => {
      const timer = setTimeout(async() => {
        if (this.retryTimers.get(tabId) !== timer) return;
        try {
          await Electron.net.fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(3_000) as any,
          });
        } catch {
          // Still unreachable — back off and keep polling
          if (this.retryTimers.get(tabId) === timer && this.views.has(tabId)) {
            attempt(Math.min(delayMs * 2, BrowserTabViewManager.RETRY_MAX_INTERVAL_MS));
          }

          return;
        }

        if (this.retryTimers.get(tabId) !== timer) return;
        console.log(`[BrowserTabView] Auto-retry: server reachable again, reloading tabId=${ tabId }`);
        this.stopRetry(tabId);
        this.getWebContents(tabId)?.loadURL(url).catch(() => {});
      }, delayMs);

      timer.unref?.();
      this.retryTimers.set(tabId, timer);
    };

    attempt(BrowserTabViewManager.RETRY_INTERVAL_MS);
    console.log(`[BrowserTabView] Auto-retry started for tabId=${ tabId } (5s backing off to ${ BrowserTabViewManager.RETRY_MAX_INTERVAL_MS / 1000 }s)`);
  }

  private stopRetry(tabId: string): void {
    const timer = this.retryTimers.get(tabId);

    if (timer) {
      clearTimeout(timer);
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
  /** Build (or reuse) the origin → accounts index for saved website logins. */
  private async vaultAccountsByOrigin(): Promise<Map<string, VaultAccountMatch[]>> {
    if (this.vaultIndex && Date.now() - this.vaultIndex.builtAt < VAULT_INDEX_TTL_MS) {
      return this.vaultIndex.byOrigin;
    }
    if (this.vaultIndexBuild) return this.vaultIndexBuild;

    this.vaultIndexBuild = (async() => {
      const byOrigin = new Map<string, VaultAccountMatch[]>();
      const { getIntegrationService } = await import('@pkg/agent/services/IntegrationService');
      const service = getIntegrationService();
      const accounts = await service.getAccounts('website');

      for (const acct of accounts) {
        const urlValue = await service.getIntegrationValue('website', 'website_url', acct.account_id);
        if (!urlValue?.value) continue;
        let origin: string;
        try {
          origin = new URL(urlValue.value).origin;
        } catch {
          continue;
        }
        const usernameValue = await service.getIntegrationValue('website', 'username', acct.account_id);
        const list = byOrigin.get(origin) ?? [];
        list.push({ accountId: acct.account_id, username: usernameValue?.value || acct.label, origin });
        byOrigin.set(origin, list);
      }
      this.vaultIndex = { builtAt: Date.now(), byOrigin };

      return byOrigin;
    })().finally(() => {
      this.vaultIndexBuild = null;
    });

    return this.vaultIndexBuild;
  }

  private invalidateVaultIndex(): void {
    this.vaultIndex = null;
  }

  /**
   * Send the saved accounts for `frame`'s own origin to that frame. The
   * page's __sullaVaultSetAccounts() receives them and shows the dropdown.
   */
  private async sendVaultMatchesToFrame(frame: Electron.WebFrameMain): Promise<void> {
    const origin = trustedFrameOrigin(frame);
    if (!origin) return;
    try {
      const matches = (await this.vaultAccountsByOrigin()).get(origin) ?? [];
      if (matches.length === 0 || trustedFrameOrigin(frame) !== origin) return;
      frame.executeJavaScript(`window.__sullaVaultSetAccounts && window.__sullaVaultSetAccounts(${ JSON.stringify(matches) });`).catch(() => {});
    } catch (err) {
      console.error('[BrowserTabView] sendVaultMatchesToFrame error:', err);
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
      this.invalidateVaultIndex();
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
      this.invalidateVaultIndex();
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
  private async setPendingCredentials(tabId: string, origin: string, username: string, password: string, pageTitle?: string, frame?: Electron.WebFrameMain): Promise<void> {
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
        } catch { continue }

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
          origin,
          username,
          password,
          timer,
          pageTitle,
          existingAccountId: acct.account_id,
          frame,
        });
        this.pushSaveToastToPage(tabId, true);
        return;
      }

      // No matching username — show save-new toast
      const timer = setTimeout(() => this.clearPendingCredentials(tabId), 90_000);
      this.pendingCredentials.set(tabId, {
        origin, username, password, timer, pageTitle, frame,
      });
      this.pushSaveToastToPage(tabId, false);
    } catch (err) {
      console.error('[BrowserTabView] setPendingCredentials check failed:', err);
      // Fallback: show save toast anyway
      const timer = setTimeout(() => this.clearPendingCredentials(tabId), 90_000);
      this.pendingCredentials.set(tabId, {
        origin, username, password, timer, pageTitle, frame,
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
    const script = `window.__sullaVaultShowPendingSaveToast && window.__sullaVaultShowPendingSaveToast(${ JSON.stringify(pending.origin) }, ${ JSON.stringify(pending.username) }, ${ JSON.stringify(action) });`;

    // Only ever show the toast to a frame that still has the origin the
    // credential was captured on; after a cross-origin navigation it is gone.
    if (pending.frame && trustedFrameOrigin(pending.frame) === pending.origin) {
      pending.frame.executeJavaScript(script).catch(() => {});
    } else if (trustedFrameOrigin(view.webContents.mainFrame) === pending.origin) {
      view.webContents.executeJavaScript(script, true).catch(() => {});
    }
  }

  /**
   * Fill a saved login into the frame that asked for it — only when the
   * account was saved for exactly that frame's origin. Without this check any
   * page could request any account id and receive its decrypted password.
   */
  private async autofillVaultCredential(tabId: string, accountId: string, frame: Electron.WebFrameMain): Promise<void> {
    try {
      const origin = trustedFrameOrigin(frame);
      if (!origin) return;
      const allowed = ((await this.vaultAccountsByOrigin()).get(origin) ?? []).some(a => a.accountId === accountId);
      if (!allowed) {
        console.warn(`[BrowserTabView] Refused vault autofill tabId=${ tabId }: account is not saved for ${ origin }`);

        return;
      }

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

      // Re-check right before injecting: the frame may have navigated away
      // while the vault was being read.
      if (!this.views.has(tabId) || trustedFrameOrigin(frame) !== origin) return;

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
      frame.executeJavaScript(script, true).catch(() => {});
      console.log(`[BrowserTabView] Vault autofill executed for ${ accountId }`);
    } catch (err) {
      console.error('[BrowserTabView] autofillVaultCredential error:', err);
    }
  }

  /**
   * Window-open policy shared by browser tabs and any popup they spawn.
   *
   * `target="_blank"` links and plain `window.open(url)` calls become Sulla
   * tabs — that is what the user expects from the embedded browser.
   *
   * Sized popups (`window.open(url, name, 'width=…,height=…')`, disposition
   * `new-window`) must stay real popups. Denying them makes `window.open()`
   * return `null`, which silently breaks every popup-based federated login:
   * Google Identity Services logs "Failed to open popup window", then the
   * `display=popup` / `redirect_uri=gis_transform` URL we re-opened as a tab
   * has no opener to postMessage the credential back to, so accounts.google.com
   * bounces through /restart → /signin/oauth → /accountchooser forever.
   */
  private buildWindowOpenHandler(mainWindow: Electron.BrowserWindow) {
    return (details: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse => {
      if (this.isPopupRequest(details)) {
        return {
          action:                        'allow',
          outlivesOpener:                false,
          overrideBrowserWindowOptions:  {
            autoHideMenuBar: true,
            // Deliberately no width/height here — Electron already derives
            // those from `details.features`, and hardcoding them would
            // override the size the opener asked for.
            webPreferences:  {
              session:              this.ensureSession(),
              webSecurity:          true,
              contextIsolation:     false,
              nodeIntegration:      false,
              backgroundThrottling: false,
            },
          },
        };
      }

      openUrlInApp(details.url);

      return { action: 'deny' };
    };
  }

  /**
   * True when the page asked for a popup window rather than a new tab.
   *
   * Chromium reports `new-window` for `window.open` calls that carry window
   * features; `features` is also non-empty in that case. Anything else —
   * `foreground-tab`, `background-tab`, `default` — is a link the user would
   * expect to land in a Sulla tab.
   */
  private isPopupRequest(details: Electron.HandlerDetails): boolean {
    if (details.disposition !== 'new-window' && !details.features) {
      return false;
    }

    // Only real web content gets a native window; never javascript:, file:,
    // data: or app:// URLs, which would escape the browser sandbox.
    try {
      const { protocol } = new URL(details.url);

      return protocol === 'https:' || protocol === 'http:';
    } catch {
      return false;
    }
  }

  /**
   * Apply browser-tab semantics to a popup Electron just created for us:
   * same window-open policy, console forwarding, and a guard so a popup can
   * never outlive the app window it belongs to.
   */
  private configurePopupWindow(popup: Electron.BrowserWindow, url: string, mainWindow: Electron.BrowserWindow): void {
    console.log(`[BrowserTabView] popup window opened url=${ url }`);

    popup.webContents.setWindowOpenHandler(this.buildWindowOpenHandler(mainWindow));
    popup.webContents.on('did-create-window', (nested, details) => {
      this.configurePopupWindow(nested, details.url, mainWindow);
    });

    popup.webContents.on('console-message', (event) => {
      console.log(`[BrowserTabView:popup@${ event.lineNumber }] [${ event.level }] ${ event.message }`);
    });

    const closePopup = () => {
      if (!popup.isDestroyed()) {
        popup.close();
      }
    };

    mainWindow.once('closed', closePopup);
    popup.once('closed', () => mainWindow.removeListener('closed', closePopup));

    popup.once('ready-to-show', () => popup.focus());
  }

  private attachListeners(tabId: string, view: WebContentsView, mainWindow: Electron.BrowserWindow): void {
    const wc = view.webContents;

    wc.setWindowOpenHandler(this.buildWindowOpenHandler(mainWindow));

    // A real popup keeps `window.opener` alive; that channel is how federated
    // sign-in hands the credential back. Wire the new window into the same
    // session/handlers the tab views use so nested popups behave too.
    wc.on('did-create-window', (popup, details) => {
      this.configurePopupWindow(popup, details.url, mainWindow);
    });

    const sendState = () => {
      // If we're showing an error page (data: URL), report the original
      // failed URL so the address bar stays readable and retryable.
      const currentUrl = wc.getURL();
      const displayUrl = (currentUrl.startsWith('data:') && this.failedUrls.has(tabId))
        ? this.failedUrls.get(tabId)!
        : currentUrl;

      // Update the main-process registry — it fans out to subscribers via
      // its own onChange event. Eliminates the direct renderer IPC path
      // and the associated "Render frame was disposed" races.
      tabRegistry.updateMeta(tabId, {
        url:       displayUrl,
        title:     wc.getTitle(),
        isLoading: wc.isLoading(),
      });

      // Still send the full navigation state to the main window for the
      // address bar chrome (handles back/forward state which is not in
      // the registry shape).
      safeSend(mainWindow.webContents, 'browser-tab-view:state-update', {
        tabId,
        url:          displayUrl,
        title:        wc.getTitle(),
        canGoBack:    wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        isLoading:    wc.isLoading(),
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
    // The injected menu reports clicks through __sullaBridgeEmit, which the
    // page itself can also call. Only honour an action while a menu Sulla
    // actually opened (from a native right-click) is live, and only once.
    let contextMenuArmedUntil = 0;

    wc.on('context-menu', (_event, params) => {
      if (mainWindow.isDestroyed()) return;
      contextMenuArmedUntil = Date.now() + CONTEXT_MENU_ARM_MS;

      const ctx = {
        tabId,
        x:                     params.x,
        y:                     params.y,
        selectionText:         params.selectionText || '',
        linkURL:               params.linkURL || '',
        srcURL:                params.srcURL || '',
        mediaType:             params.mediaType || '',
        isEditable:            params.isEditable,
        misspelledWord:        params.misspelledWord || '',
        dictionarySuggestions: params.dictionarySuggestions || [],
        canGoBack:             wc.navigationHistory.canGoBack(),
        canGoForward:          wc.navigationHistory.canGoForward(),
        pageURL:               wc.getURL(),
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
      if (msg.type === 'sulla:view-scroll-heartbeat') {
        this.handleScrollHeartbeat(tabId, msg.data?.moved === true);
        return;
      }
      if (msg.type !== 'context-menu-action') return;
      if (Date.now() > contextMenuArmedUntil) {
        console.warn(`[BrowserTabView] ignored context-menu action without an open menu tabId=${ tabId }`);

        return;
      }
      contextMenuArmedUntil = 0;
      const { action, ...data } = msg.data || {};

      // Always remove the menu element first to avoid it interfering
      // with actions like select-all or DOM-based operations.
      wc.executeJavaScript(
        'var m=document.querySelector("sulla-context-menu");if(m)m.remove();', true,
      ).catch(() => {}).then(() => {
        switch (action) {
        case 'copy': wc.copy(); break;
        case 'cut': wc.cut(); break;
        case 'paste': wc.paste(); break;
        case 'select-all': wc.selectAll(); break;
        case 'undo': wc.undo(); break;
        case 'redo': wc.redo(); break;
        case 'go-back': wc.navigationHistory.goBack(); break;
        case 'go-forward': wc.navigationHistory.goForward(); break;
        case 'reload': wc.reload(); break;
        case 'copy-image': wc.copyImageAt(data.x ?? 0, data.y ?? 0); break;
        case 'inspect': wc.inspectElement(data.x ?? 0, data.y ?? 0); break;
        case 'replace-selection': wc.replace(data.text ?? ''); break;
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
          safeSend(mainWindow.webContents, 'browser-context-menu:ai-action', { tabId, action, ...data });
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
      console.warn(`[BrowserTabView] certificate-error tabId=${ tabId } error=${ error } url=${ redactUrl(url) }`);
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

    // Previously we forwarded sulla:injected / sulla:routeChanged / sulla:click
    // / sulla:pageContent / sulla:contentAdded / sulla:dialog to the renderer
    // for the WebviewHostBridge state machine. That machine is gone; no
    // consumer left. Vault and context-menu events still have dedicated
    // wc.ipc.on handlers below — those stay.

    // ── Vault: handle bridge events from guest pages ──
    // Route vault-related events from the guest bridge to the renderer.
    // Uses wc.ipc.on() which receives the payload as { type, data } directly,
    // matching the preload's ipcRenderer.send('browser-tab-view:bridge-event', { type, data }).
    wc.ipc.on('browser-tab-view:bridge-event', (event: Electron.IpcMainEvent, msg: { type: string; data: any }) => {
      if (!msg?.type?.startsWith('sulla:vault:')) return;

      // Pages can call __sullaBridgeEmit themselves (contextIsolation is off),
      // so the payload's `origin` is attacker-controlled. Vault access is
      // scoped to the origin the browser process says the SENDING frame has.
      const frame = event.senderFrame;
      const origin = trustedFrameOrigin(frame);
      if (!frame || !origin) return;

      const { type, data } = msg;

      if (type === 'sulla:vault:getMatches' || type === 'sulla:vault:loginFormDetected') {
        this.sendVaultMatchesToFrame(frame);
      }

      if (type === 'sulla:vault:credentialsPending') {
        if (typeof data?.username !== 'string' || typeof data?.password !== 'string') return;
        this.setPendingCredentials(tabId, origin, data.username, data.password, typeof data.title === 'string' ? data.title : undefined, frame);
      }

      if (type === 'sulla:vault:credentialsCaptured') {
        // User clicked "Save" or "Update" — retrieve password from pending store
        const pending = this.pendingCredentials.get(tabId);

        if (pending?.origin === origin) {
          if (pending.existingAccountId) {
            this.updateVaultPassword(pending.existingAccountId, pending.password);
          } else {
            this.saveVaultCredential(pending.origin, pending.username, pending.password, pending.pageTitle);
          }
          this.clearPendingCredentials(tabId);
        }
      }

      if (type === 'sulla:vault:credentialsDismissed') {
        this.clearPendingCredentials(tabId);
      }

      if (type === 'sulla:vault:autofillRequest' && typeof data?.accountId === 'string') {
        this.autofillVaultCredential(tabId, data.accountId, frame);
      }
    });

    // Also check vault on successful navigation (for pages where the login
    // form is already rendered in the initial HTML, not SPA-injected)
    // Re-show the save toast after a post-login navigation. (The old
    // per-load vault lookup here fed an IPC nothing listened to.)
    wc.on('did-stop-loading', () => {
      const pending = this.pendingCredentials.get(tabId);
      if (pending) {
        this.pushSaveToastToPage(tabId, !!pending.existingAccountId);
      }
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
      console.warn(`[BrowserTabView] did-fail-load tabId=${ tabId } code=${ errorCode } desc=${ errorDescription } url=${ redactUrl(validatedURL) }`);

      // Start polling — check every 5 seconds if the site is back up
      this.startRetry(tabId, validatedURL);
    });
  }
}

/**
 * Strip query string and fragment before a URL is logged — they routinely
 * carry session tokens, OAuth codes and signed-URL secrets.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.protocol === 'data:') return 'data:(redacted)';

    return `${ parsed.origin }${ parsed.pathname }${ parsed.search || parsed.hash ? '?…' : '' }`;
  } catch {
    return '(unparseable url)';
  }
}

/** Escape text for safe interpolation into HTML element content and quoted attributes. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) URLs may become clickable links on the generated pages. */
function safeHref(url: string): string {
  try {
    const { protocol } = new URL(url);

    return protocol === 'http:' || protocol === 'https:' ? escapeHtml(url) : '#';
  } catch {
    return '#';
  }
}

/**
 * Generates a Chrome-style error page. Every interpolated value is escaped:
 * URLs, hostnames and error text are attacker-influenced, and this page runs
 * with the tab preload (bridge + vault hooks) attached.
 */
export function buildErrorPage(url: string, errorCode: number, errorDescription: string): string {
  // Map common Chromium network error codes to user-friendly messages
  const messages: Record<number, { title: string; detail: string }> = {
    [-2]:   { title: 'Network error', detail: 'A network error occurred.' },
    [-6]:   { title: 'File not found', detail: 'The file could not be found.' },
    [-7]:   { title: 'Too many redirects', detail: 'The page redirected too many times.' },
    [-15]:  { title: 'Connection reset', detail: 'The connection was reset.' },
    [-21]:  { title: 'Network changed', detail: 'A network change was detected.' },
    [-100]: { title: 'Connection closed', detail: 'The connection was closed unexpectedly.' },
    [-101]: { title: 'Connection reset', detail: 'The connection was reset.' },
    [-102]: { title: 'Connection refused', detail: 'The server refused the connection.' },
    [-103]: { title: 'Connection failed', detail: 'Could not connect to the server.' },
    [-104]: { title: 'Connection failed', detail: 'Could not connect to the server.' },
    [-105]: { title: 'Name not resolved', detail: 'The server\'s DNS address could not be found.' },
    [-106]: { title: 'Internet disconnected', detail: 'You are not connected to the internet.' },
    [-109]: { title: 'Address unreachable', detail: 'The server address is unreachable.' },
    [-110]: { title: 'SSL protocol error', detail: 'An SSL protocol error occurred.' },
    [-112]: { title: 'Connection timed out', detail: 'The connection to the server timed out.' },
    [-118]: { title: 'Connection timed out', detail: 'The connection to the server timed out.' },
    [-130]: { title: 'Proxy connection failed', detail: 'Could not connect through the proxy server.' },
    [-200]: { title: 'Certificate error', detail: 'The server\'s certificate is not trusted.' },
    [-201]: { title: 'Certificate date invalid', detail: 'The server\'s certificate has expired or is not yet valid.' },
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
  <title>${ escapeHtml(info.title) }</title>
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
    <h1>${ escapeHtml(info.title) }</h1>
    <p class="hostname">${ escapeHtml(hostname) }</p>
    <p class="detail">${ escapeHtml(info.detail) }</p>
    <a class="retry-btn" href="${ safeHref(url) }">Reload</a>
    <p class="error-code">ERR_${ escapeHtml(errorDescription.replace(/^net::ERR_/i, '').replace(/\s+/g, '_').toUpperCase()) } (${ Number(errorCode) })</p>
  </div>
</body>
</html>`;
}

/**
 * Generates a Chrome-style certificate warning page with Advanced / Proceed
 * option. Certificate subject/issuer come straight from the (untrusted)
 * server, so every interpolated value is escaped.
 */
export function buildCertErrorPage(url: string, error: string, certificate: Electron.Certificate): string {
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
    <p class="hostname">${ escapeHtml(hostname) }</p>
    <p class="detail">
      Attackers might be trying to steal your information from <strong>${ escapeHtml(hostname) }</strong>
      (for example, passwords, messages, or credit cards). The server's security certificate
      is not trusted by this application.
    </p>
    <a class="btn" href="${ safeHref(url) }">Back to safety</a>
    <button class="advanced-toggle" onclick="document.getElementById('adv').classList.toggle('open')">
      Advanced
    </button>
    <div id="adv" class="advanced-section">
      <table class="cert-table">
        <tr><td>Subject</td><td>${ escapeHtml(subject) }</td></tr>
        <tr><td>Issuer</td><td>${ escapeHtml(issuer) }</td></tr>
        <tr><td>Valid from</td><td>${ escapeHtml(validFrom) }</td></tr>
        <tr><td>Valid until</td><td>${ escapeHtml(validTo) }</td></tr>
        <tr><td>Fingerprint</td><td>${ escapeHtml(fingerprint) }</td></tr>
        <tr><td>Error</td><td>${ escapeHtml(error) }</td></tr>
      </table>
      <p class="proceed-warning">
        This server could not prove that it is <strong>${ escapeHtml(hostname) }</strong>; its security
        certificate is not trusted. Proceeding may expose your data to third parties.
      </p>
      <a class="btn btn-proceed" href="sulla://accept-cert">Proceed to ${ escapeHtml(hostname) } (unsafe)</a>
    </div>
    <p class="error-code">NET::${ escapeHtml(error.toUpperCase().replace(/\s+/g, '_')) }</p>
  </div>
</body>
</html>`;
}
