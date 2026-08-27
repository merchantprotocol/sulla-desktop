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
