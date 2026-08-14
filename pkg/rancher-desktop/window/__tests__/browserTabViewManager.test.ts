import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('electron', () => ({
  default:         {},
  WebContentsView: jest.fn(),
  session:         { fromPartition: jest.fn() },
}));

jest.unstable_mockModule('@pkg/SullaWebRequestFixer', () => ({
  SullaWebRequestFixer: jest.fn(),
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
  getWindow:    jest.fn(() => null),
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
});
