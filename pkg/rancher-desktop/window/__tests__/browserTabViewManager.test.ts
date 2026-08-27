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
    (WebContentsView as any).mockReturnValue(replacement);
    (getWindow as any).mockReturnValue({ contentView });
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
});
