import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * Production hardening for embedded browser tabs: vault access is bound to
 * the sending frame's real origin, generated pages escape untrusted text,
 * context-menu actions need a real right-click, idle background tabs sleep,
 * and failed-load retries back off.
 */

const mockBrowserSession = {
  cookies: {
    flushStore: jest.fn(() => Promise.resolve()),
    on:         jest.fn(),
  },
  getUserAgent:          jest.fn(() => 'Chrome Electron/40.0 SullaDesktop/1.0'),
  setUserAgent:          jest.fn(),
  on:                    jest.fn(),
  getPreloadScripts:     jest.fn(() => []),
  registerPreloadScript:       jest.fn(),
  setPermissionCheckHandler:   jest.fn(),
  setPermissionRequestHandler: jest.fn(),
};

function makeWebContents() {
  const handlers = new Map<string, ((...args: any[]) => void)[]>();
  const ipcHandlers = new Map<string, ((...args: any[]) => void)[]>();
  const add = (map: typeof handlers) => (name: string, fn: (...args: any[]) => void) => {
    map.set(name, [...(map.get(name) ?? []), fn]);
  };

  return {
    session:                 mockBrowserSession,
    ipc:                     { on: jest.fn(add(ipcHandlers)) },
    on:                      jest.fn(add(handlers)),
    setBackgroundThrottling: jest.fn(),
    setWindowOpenHandler:    jest.fn(),
    loadURL:                 jest.fn(() => Promise.resolve()),
    getURL:                  jest.fn(() => 'https://app.example.com/'),
    getTitle:                jest.fn(() => ''),
    isLoading:               jest.fn(() => false),
    isDestroyed:             jest.fn(() => false),
    isCurrentlyAudible:      jest.fn(() => false),
    executeJavaScript:       jest.fn(() => Promise.resolve()),
    copy:                    jest.fn(),
    inspectElement:          jest.fn(),
    navigationHistory:       { canGoBack: () => false, canGoForward: () => false },
    mainFrame:               { origin: 'https://app.example.com', executeJavaScript: jest.fn(() => Promise.resolve()) },
    emitIpc(name: string, ...args: any[]) {
      for (const fn of ipcHandlers.get(name) ?? []) fn(...args);
    },
    emit(name: string, ...args: any[]) {
      for (const fn of handlers.get(name) ?? []) fn(...args);
    },
  };
}

let currentWebContents = makeWebContents();
const mockView = {
  get webContents() {
    return currentWebContents;
  },
  setBounds:  jest.fn(),
  setVisible: jest.fn(),
};
const mockWebContentsView = jest.fn((_options?: unknown) => mockView);
const mockMainWindow = {
  contentView: {
    addChildView:    jest.fn(),
    removeChildView: jest.fn(),
  },
  webContents: {},
  isDestroyed: () => false,
  isVisible:   () => true,
  isMinimized: () => false,
  once:        jest.fn(),
};
const mockNetFetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED')));

jest.unstable_mockModule('electron', () => ({
  default:         { net: { fetch: mockNetFetch } },
  WebContentsView: mockWebContentsView,
  session:         { fromPartition: jest.fn(() => mockBrowserSession) },
}));

jest.unstable_mockModule('@pkg/SullaWebRequestFixer', () => ({
  SullaWebRequestFixer: jest.fn(() => ({ attachToSession: jest.fn() })),
}));

jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: { sulla: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}));

jest.unstable_mockModule('@pkg/main/browserTabs/TabRegistry', () => ({
  tabRegistry: { updateMeta: jest.fn() },
}));

jest.unstable_mockModule('@pkg/utils/paths', () => ({ default: { resources: '/tmp' } }));
jest.unstable_mockModule('@pkg/utils/safeSend', () => ({ safeSend: jest.fn() }));
jest.unstable_mockModule('@pkg/window', () => ({
  getWindow:    jest.fn(() => mockMainWindow),
  openUrlInApp: jest.fn(),
}));
jest.unstable_mockModule('@pkg/window/browserContextMenu', () => ({
  buildContextMenuInjection: jest.fn(() => ''),
}));

// Two saved logins: one for the page's own origin, one for github.com.
const vaultValues: Record<string, Record<string, string>> = {
  app_example_alice: { website_url: 'https://app.example.com/login', username: 'alice', password: 'app-secret' },
  github_bob:        { website_url: 'https://github.com/login', username: 'bob', password: 'github-secret' },
};
// eslint-disable-next-line camelcase -- IntegrationService's row shape
const vaultAccounts = () => Object.keys(vaultValues).map(accountId => ({ account_id: accountId, label: accountId }));
const mockIntegrationService = {
  getAccounts:         jest.fn(() => Promise.resolve(vaultAccounts())),
  getIntegrationValue: jest.fn((_i: string, property: string, accountId: string) => Promise.resolve({ value: vaultValues[accountId]?.[property] })),
  getFormValues:       jest.fn((_i: string, accountId: string) => Promise.resolve(Object.entries(vaultValues[accountId] ?? {}).map(([property, value]) => ({ property, value })))),
  initialize:          jest.fn(() => Promise.resolve()),
};
jest.unstable_mockModule('@pkg/agent/services/IntegrationService', () => ({
  getIntegrationService: () => mockIntegrationService,
}));

async function loadModule() {
  jest.resetModules();

  return import('../browserTabViewManager');
}

async function createManagerWithView(tabId = 'tab-a') {
  const mod = await loadModule();
  const manager = mod.BrowserTabViewManager.getInstance();

  manager.createView(tabId, 'https://app.example.com/', { x: 0, y: 0, width: 800, height: 600 });

  return { mod, manager };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function frame(origin: string) {
  return { origin, detached: false, executeJavaScript: jest.fn(() => Promise.resolve()) };
}

describe('BrowserTabViewManager hardening', () => {
  beforeEach(() => {
    currentWebContents = makeWebContents();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('vault access is bound to the sending frame origin', () => {
    it('ignores a page-supplied origin and returns only accounts for the frame origin', async() => {
      await createManagerWithView();
      const sender = frame('https://evil.example');

      // A malicious page claims to be github.com.
      currentWebContents.emitIpc('browser-tab-view:bridge-event', { senderFrame: sender }, {
        type: 'sulla:vault:getMatches',
        data: { origin: 'https://github.com' },
      });
      await flush();
      await flush();

      expect(sender.executeJavaScript).not.toHaveBeenCalled();
    });

    it('sends the frame its own origin accounts', async() => {
      await createManagerWithView();
      const sender = frame('https://app.example.com');

      currentWebContents.emitIpc('browser-tab-view:bridge-event', { senderFrame: sender }, {
        type: 'sulla:vault:getMatches',
        data: { origin: 'https://whatever.invalid' },
      });
      await flush();
      await flush();

      expect(sender.executeJavaScript).toHaveBeenCalledTimes(1);
      const script = (sender.executeJavaScript.mock.calls[0] as unknown as [string])[0];
      expect(script).toContain('alice');
      expect(script).not.toContain('bob');
    });

    it('refuses to autofill an account saved for a different origin', async() => {
      await createManagerWithView();
      const sender = frame('https://evil.example');

      currentWebContents.emitIpc('browser-tab-view:bridge-event', { senderFrame: sender }, {
        type: 'sulla:vault:autofillRequest',
        data: { accountId: 'github_bob' },
      });
      await flush();
      await flush();

      expect(mockIntegrationService.getFormValues).not.toHaveBeenCalled();
      expect(sender.executeJavaScript).not.toHaveBeenCalled();
      expect(currentWebContents.executeJavaScript).not.toHaveBeenCalled();
    });

    it('autofills a same-origin account into the requesting frame only', async() => {
      await createManagerWithView();
      const sender = frame('https://app.example.com');

      currentWebContents.emitIpc('browser-tab-view:bridge-event', { senderFrame: sender }, {
        type: 'sulla:vault:autofillRequest',
        data: { accountId: 'app_example_alice' },
      });
      await flush();
      await flush();

      expect(sender.executeJavaScript).toHaveBeenCalledTimes(1);
      expect((sender.executeJavaScript.mock.calls[0] as unknown as [string])[0]).toContain('app-secret');
      expect(currentWebContents.executeJavaScript).not.toHaveBeenCalled();
    });

    it('builds the vault index once for repeated lookups', async() => {
      await createManagerWithView();

      for (let i = 0; i < 3; i++) {
        currentWebContents.emitIpc('browser-tab-view:bridge-event', { senderFrame: frame('https://app.example.com') }, {
          type: 'sulla:vault:loginFormDetected',
          data: {},
        });
        await flush();
        await flush();
      }

      expect(mockIntegrationService.getAccounts).toHaveBeenCalledTimes(1);
    });

    it('never grants vault access to opaque or non-web origins', async() => {
      const { trustedFrameOrigin } = await loadModule();

      expect(trustedFrameOrigin({ origin: 'null' } as any)).toBeNull();
      expect(trustedFrameOrigin({ origin: 'file://' } as any)).toBeNull();
      expect(trustedFrameOrigin({ origin: 'https://a.example', detached: true } as any)).toBeNull();
      expect(trustedFrameOrigin(null)).toBeNull();
      expect(trustedFrameOrigin({ origin: 'https://a.example' } as any)).toBe('https://a.example');
    });
  });

  describe('context-menu actions', () => {
    it('ignores actions a page emits without a native right-click', async() => {
      await createManagerWithView();

      currentWebContents.emitIpc('browser-tab-view:bridge-event', {}, { type: 'context-menu-action', data: { action: 'copy' } });
      await flush();

      expect(currentWebContents.copy).not.toHaveBeenCalled();
    });

    it('honours one action after a native right-click', async() => {
      await createManagerWithView();

      currentWebContents.emit('context-menu', {}, { x: 1, y: 2 });
      currentWebContents.emitIpc('browser-tab-view:bridge-event', {}, { type: 'context-menu-action', data: { action: 'copy' } });
      await flush();
      currentWebContents.emitIpc('browser-tab-view:bridge-event', {}, { type: 'context-menu-action', data: { action: 'copy' } });
      await flush();

      expect(currentWebContents.copy).toHaveBeenCalledTimes(1);
    });
  });

  describe('generated pages escape untrusted text', () => {
    it('escapes certificate fields and never links to non-web URLs', async() => {
      const { buildCertErrorPage, buildErrorPage } = await loadModule();
      const cert = {
        issuerName:  '<img src=x onerror=alert(1)>',
        subjectName: '"><script>steal()</script>',
        fingerprint: 'fp',
      } as any;

      const certPage = buildCertErrorPage('https://bad.example/', 'net::ERR_CERT_AUTHORITY_INVALID', cert);
      expect(certPage).not.toContain('<img src=x');
      expect(certPage).not.toContain('<script>steal');
      expect(certPage).toContain('&lt;img src=x onerror=alert(1)&gt;');

      const errorPage = buildErrorPage('javascript:alert(1)', -105, 'ERR_NAME_NOT_RESOLVED');
      expect(errorPage).toContain('href="#"');
      expect(errorPage).not.toContain('href="javascript:');
    });

    it('redacts query strings before URLs are logged', async() => {
      const { redactUrl } = await loadModule();

      expect(redactUrl('https://api.example.com/live?token=secret#x')).toBe('https://api.example.com/live?…');
      expect(redactUrl('https://example.com/a/b')).toBe('https://example.com/a/b');
      expect(redactUrl('not a url')).toBe('(unparseable url)');
    });
  });

  describe('idle background tabs', () => {
    it('sleeps a parked idle tab and wakes it for programmatic use', async() => {
      const { mod, manager } = await createManagerWithView('tab-a');
      const idle = mod.BrowserTabViewManager.IDLE_SLEEP_MS;
      const now = (manager as any).lastActiveAt.get('tab-a') as number;

      manager.sleepIdleViews(now + idle - 1);
      expect(manager.isSleeping('tab-a')).toBe(false);

      manager.sleepIdleViews(now + idle + 1);
      expect(manager.isSleeping('tab-a')).toBe(true);
      expect(mockView.setVisible).toHaveBeenLastCalledWith(false);
      expect(currentWebContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);

      manager.wakeView('tab-a');
      expect(manager.isSleeping('tab-a')).toBe(false);
      expect(mockView.setVisible).toHaveBeenLastCalledWith(true);
      expect(currentWebContents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    });

    it('never sleeps the focused, loading, or audible tab', async() => {
      const { mod, manager } = await createManagerWithView('tab-a');
      const later = Date.now() + mod.BrowserTabViewManager.IDLE_SLEEP_MS * 10;

      manager.setFocusedTab('tab-a');
      manager.sleepIdleViews(later);
      expect(manager.isSleeping('tab-a')).toBe(false);

      manager.setFocusedTab(null);
      currentWebContents.isLoading.mockReturnValue(true);
      manager.sleepIdleViews(later);
      expect(manager.isSleeping('tab-a')).toBe(false);

      currentWebContents.isLoading.mockReturnValue(false);
      currentWebContents.isCurrentlyAudible.mockReturnValue(true);
      manager.sleepIdleViews(later);
      expect(manager.isSleeping('tab-a')).toBe(false);
    });

    it('focusing a sleeping tab makes it visible and unthrottled again', async() => {
      const { mod, manager } = await createManagerWithView('tab-a');

      manager.sleepIdleViews(Date.now() + mod.BrowserTabViewManager.IDLE_SLEEP_MS + 1);
      expect(manager.isSleeping('tab-a')).toBe(true);

      manager.setFocusedTab('tab-a');
      expect(manager.isSleeping('tab-a')).toBe(false);
      expect(mockView.setVisible).toHaveBeenLastCalledWith(true);
    });
  });

  describe('failed-load auto-retry', () => {
    it('backs off from 5s towards 60s instead of polling every 5s forever', async() => {
      jest.useFakeTimers();
      const { manager } = await createManagerWithView('tab-a');

      (manager as any).startRetry('tab-a', 'http://localhost:9/');
      // Cumulative probe times with doubling back-off: 5, 15, 35, 75, 135, 195s.
      const expectations: [number, number][] = [[4_999, 0], [5_000, 1], [15_000, 2], [35_000, 3], [75_000, 4], [135_000, 5], [195_000, 6]];
      let elapsed = 0;
      for (const [at, calls] of expectations) {
        await jest.advanceTimersByTimeAsync(at - elapsed);
        elapsed = at;
        expect(mockNetFetch).toHaveBeenCalledTimes(calls);
      }
      (manager as any).stopRetry('tab-a');
      await jest.advanceTimersByTimeAsync(120_000);
      expect(mockNetFetch).toHaveBeenCalledTimes(6);
    });
  });
});
