import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockBrowserSession = {
  cookies: {
    flushStore: jest.fn(() => Promise.resolve()),
    on:         jest.fn(),
  },
  getUserAgent:          jest.fn(() => 'Chrome Electron/40.0 SullaDesktop/1.0'),
  setUserAgent:          jest.fn(),
  on:                    jest.fn(),
  getPreloadScripts:     jest.fn(() => []),
  registerPreloadScript: jest.fn(),
};
const mockWebContents = {
  session:                 mockBrowserSession,
  ipc:                     { on: jest.fn() },
  setBackgroundThrottling: jest.fn(),
  setWindowOpenHandler:    jest.fn(),
  on:                      jest.fn(),
  loadURL:                 jest.fn(() => Promise.resolve()),
  getURL:                  jest.fn(() => ''),
};
const mockView = {
  webContents: mockWebContents,
  setBounds:   jest.fn(),
  setVisible:  jest.fn(),
};
const mockWebContentsView = jest.fn((_options?: unknown) => mockView);
const mockMainWindow = {
  contentView: {
    addChildView:    jest.fn(),
    removeChildView: jest.fn(),
  },
  webContents: {},
};
const mockGetWindow = jest.fn(() => mockMainWindow);
const mockAttachToSession = jest.fn();

jest.unstable_mockModule('electron', () => ({
  default:         {},
  WebContentsView: mockWebContentsView,
  session:         { fromPartition: jest.fn(() => mockBrowserSession) },
}));

jest.unstable_mockModule('@pkg/SullaWebRequestFixer', () => ({
  SullaWebRequestFixer: jest.fn(() => ({ attachToSession: mockAttachToSession })),
}));

jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: {
    sulla: {
      log:   jest.fn(),
      warn:  jest.fn(),
      error: jest.fn(),
    },
  },
}));

jest.unstable_mockModule('@pkg/main/browserTabs/TabRegistry', () => ({
  tabRegistry: {},
}));

jest.unstable_mockModule('@pkg/utils/paths', () => ({
  default: { resources: '/tmp' },
}));

jest.unstable_mockModule('@pkg/utils/safeSend', () => ({
  safeSend: jest.fn(),
}));

jest.unstable_mockModule('@pkg/window', () => ({
  getWindow:    mockGetWindow,
  openUrlInApp: jest.fn(),
}));

jest.unstable_mockModule('@pkg/window/browserContextMenu', () => ({
  buildContextMenuInjection: jest.fn(),
}));

async function loadManager() {
  jest.resetModules();
  return import('../browserTabViewManager');
}

describe('BrowserTabViewManager', () => {
  afterEach(() => {
    jest.clearAllMocks();
    mockWebContents.getURL.mockReturnValue('');
  });

  it('ignores stale focus clears from tabs that no longer own focus', async() => {
    const { BrowserTabViewManager } = await loadManager();
    const manager = BrowserTabViewManager.getInstance();

    manager.setFocusedTab('tab-a');
    manager.setFocusedTab('tab-b');
    manager.setFocusedTab(null, 'tab-a');

    expect(manager.getFocusedTab()).toBe('tab-b');
  });

  it('allows the focused tab to clear its own focus', async() => {
    const { BrowserTabViewManager } = await loadManager();
    const manager = BrowserTabViewManager.getInstance();

    manager.setFocusedTab('tab-a');
    manager.setFocusedTab(null, 'tab-a');

    expect(manager.getFocusedTab()).toBeNull();
  });

  it('recovers after three wheel events fail to move a scrollable target', async() => {
    const { BrowserTabViewManager } = await loadManager();
    const manager = BrowserTabViewManager.getInstance();
    const recover = jest.spyOn(manager as any, 'recoverWedgedView').mockResolvedValue(undefined);

    manager.setFocusedTab('tab-a');
    (manager as any).viewHealth.set('tab-a', (manager as any).newViewHealth());
    (manager as any).handleScrollHeartbeat('tab-a', false);
    (manager as any).handleScrollHeartbeat('tab-a', false);
    (manager as any).handleScrollHeartbeat('tab-a', false);

    expect(recover).toHaveBeenCalledWith(
      'tab-a',
      'wheel events reached a scrollable DOM target without scroll movement',
    );
  });

  it('clears the input watchdog after scroll movement resumes', async() => {
    const { BrowserTabViewManager } = await loadManager();
    const manager = BrowserTabViewManager.getInstance();
    const recover = jest.spyOn(manager as any, 'recoverWedgedView').mockResolvedValue(undefined);

    manager.setFocusedTab('tab-a');
    (manager as any).viewHealth.set('tab-a', (manager as any).newViewHealth());
    (manager as any).handleScrollHeartbeat('tab-a', false);
    (manager as any).handleScrollHeartbeat('tab-a', false);
    (manager as any).handleScrollHeartbeat('tab-a', true);
    (manager as any).handleScrollHeartbeat('tab-a', false);

    expect(recover).not.toHaveBeenCalled();
  });

  it('recovers after two consecutive empty capture probes', async() => {
    const { BrowserTabViewManager } = await loadManager();
    const manager = BrowserTabViewManager.getInstance();
    const recover = jest.spyOn(manager as any, 'recoverWedgedView').mockResolvedValue(undefined);

    (manager as any).viewHealth.set('tab-a', (manager as any).newViewHealth());
    await (manager as any).recordCaptureFailure('tab-a', 'empty NativeImage');
    expect(recover).not.toHaveBeenCalled();

    await (manager as any).recordCaptureFailure('tab-a', 'empty NativeImage');
    expect(recover).toHaveBeenCalledWith('tab-a', 'capture watchdog: empty NativeImage');
  });

  it('recreates the view while preserving webContents when re-attach was insufficient', async() => {
    const { BrowserTabViewManager } = await loadManager();
    const { WebContentsView } = await import('electron');
    const { getWindow } = await import('@pkg/window');
    const manager = BrowserTabViewManager.getInstance();
    const webContents = {
      focus:                   jest.fn(),
      setBackgroundThrottling: jest.fn(),
    };
    const original = { webContents };
    const replacement = {
      webContents,
      setBounds: jest.fn(),
    };
    const contentView = {
      addChildView:    jest.fn(),
      removeChildView: jest.fn(),
    };
    const health = (manager as any).newViewHealth();

    health.recoveryStage = 'reattached';
    (WebContentsView as any).mockReturnValueOnce(replacement);
    (getWindow as any).mockReturnValueOnce({ contentView });
    (manager as any).focusedTabId = 'tab-a';
    (manager as any).views.set('tab-a', original);
    (manager as any).latestBounds.set('tab-a', { x: 1, y: 2, width: 3, height: 4 });
    (manager as any).viewHealth.set('tab-a', health);

    await (manager as any).recoverWedgedView('tab-a', 'scroll still stuck');

    expect(WebContentsView).toHaveBeenCalledWith({ webContents });
    expect(contentView.removeChildView).toHaveBeenCalledWith(original);
    expect(contentView.addChildView).toHaveBeenCalledWith(replacement);
    expect((manager as any).views.get('tab-a')).toBe(replacement);
    expect(webContents.focus).toHaveBeenCalled();
  });

  describe('window.open policy', () => {
    const popupDetails = {
      url:         'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&display=popup',
      frameName:   '',
      features:    'toolbar=no,width=500,height=600',
      disposition: 'new-window',
    } as any;

    it('opens a real popup window for sized window.open calls so window.opener survives', async() => {
      const { BrowserTabViewManager } = await loadManager();
      const { openUrlInApp } = await import('@pkg/window');
      const manager = BrowserTabViewManager.getInstance();

      const result = (manager as any).buildWindowOpenHandler(mockMainWindow)(popupDetails);

      expect(result.action).toBe('allow');
      expect(result.overrideBrowserWindowOptions.webPreferences.session).toBe(mockBrowserSession);
      // Electron derives the popup size from `features`; overriding it here
      // would ignore the size the opener asked for.
      expect(result.overrideBrowserWindowOptions).not.toHaveProperty('width');
      expect(openUrlInApp).not.toHaveBeenCalled();
    });

    it('routes target="_blank" links into a Sulla tab', async() => {
      const { BrowserTabViewManager } = await loadManager();
      const { openUrlInApp } = await import('@pkg/window');
      const manager = BrowserTabViewManager.getInstance();

      const result = (manager as any).buildWindowOpenHandler(mockMainWindow)({
        ...popupDetails,
        url:         'https://example.com/docs',
        features:    '',
        disposition: 'foreground-tab',
      });

      expect(result).toEqual({ action: 'deny' });
      expect(openUrlInApp).toHaveBeenCalledWith('https://example.com/docs');
    });

    it('never grants a native window to non-web schemes', async() => {
      const { BrowserTabViewManager } = await loadManager();
      const manager = BrowserTabViewManager.getInstance();

      for (const url of ['file:///etc/passwd', 'app://index.html', 'data:text/html,<h1>x', 'not a url']) {
        expect((manager as any).isPopupRequest({ ...popupDetails, url })).toBe(false);
      }
    });
  });

  it('constructs tabs with the shared persistent session and visible-page throttling policy', async() => {
    const { BrowserTabViewManager } = await loadManager();
    const manager = BrowserTabViewManager.getInstance();

    manager.createView('cookie-tab', 'http://localhost:3000', { x: 10, y: 20, width: 800, height: 600 });

    expect(mockWebContentsView).toHaveBeenCalledWith({
      webPreferences: expect.objectContaining({
        session:              mockBrowserSession,
        backgroundThrottling: false,
      }),
    });
    expect(mockWebContents.session).toBe(mockBrowserSession);
    expect(mockAttachToSession).toHaveBeenCalledWith(mockBrowserSession);

    manager.setFocusedTab('cookie-tab');

    expect(mockView.setVisible).toHaveBeenCalledWith(true);
    expect(mockWebContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
    expect(mockMainWindow.contentView.addChildView).toHaveBeenCalledWith(mockView);
  });
});
