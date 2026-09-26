/**
 * @jest-environment node
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockManager = {
  createView:     jest.fn(),
  destroyView:    jest.fn(),
  wakeView:       jest.fn(),
  getWebContents: jest.fn((): any => ({ loadURL: jest.fn(() => Promise.resolve()) })),
};
const browserSession = { id: 'browser' };
const appSession = { id: 'app' };
const mockAllWebContents: any[] = [];
const mockSafeSend = jest.fn();
const mockHandle = jest.fn();

jest.unstable_mockModule('@pkg/window/browserTabViewManager', () => ({
  BrowserTabViewManager: { getInstance: () => mockManager },
}));
jest.unstable_mockModule('../GuestBridge', () => ({
  GuestBridge: jest.fn((wc: unknown, assetId: string) => ({ wc, assetId })),
}));
jest.unstable_mockModule('../browserSession', () => ({
  getBrowserSession: () => browserSession,
}));
jest.unstable_mockModule('electron', () => ({
  ipcMain:     { handle: mockHandle },
  webContents: { getAllWebContents: () => mockAllWebContents },
}));
jest.unstable_mockModule('@pkg/utils/safeSend', () => ({ safeSend: mockSafeSend }));

async function load() {
  jest.resetModules();
  const { tabRegistry } = await import('../TabRegistry');
  const { initTabsIpc } = await import('../tabsIpc');

  return { tabRegistry, initTabsIpc };
}

const nextTick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('TabRegistry efficiency', () => {
  afterEach(() => {
    jest.clearAllMocks();
    mockAllWebContents.length = 0;
  });

  it('coalesces a burst of navigation updates into one change event', async() => {
    const { tabRegistry } = await load();
    const listener = jest.fn();

    tabRegistry.open({ assetId: 'a', url: 'https://a.example', origin: 'user' });
    await nextTick();
    tabRegistry.onChange(listener);

    tabRegistry.updateMeta('a', { isLoading: true });
    tabRegistry.updateMeta('a', { url: 'https://a.example/next' });
    tabRegistry.updateMeta('a', { title: 'Next' });
    tabRegistry.updateMeta('a', { isLoading: false });
    expect(listener).not.toHaveBeenCalled();

    await nextTick();
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as any[])[0]).toMatchObject({ url: 'https://a.example/next', title: 'Next', isLoading: false });
  });

  it('does not notify for metadata that did not change', async() => {
    const { tabRegistry } = await load();

    tabRegistry.open({ assetId: 'a', url: 'https://a.example', title: 'A', origin: 'user' });
    await nextTick();
    const listener = jest.fn();
    tabRegistry.onChange(listener);

    tabRegistry.updateMeta('a', { url: 'https://a.example', title: 'A' });
    await nextTick();

    expect(listener).not.toHaveBeenCalled();
  });

  it('wakes a tab before handing an agent a bridge to it', async() => {
    const { tabRegistry } = await load();

    tabRegistry.open({ assetId: 'a', url: 'https://a.example', origin: 'agent' });
    const bridge = tabRegistry.bridge('a');

    expect(bridge).not.toBeNull();
    expect(mockManager.wakeView).toHaveBeenCalledWith('a');
  });

  it('broadcasts the tab list to app windows but never to browser-tab guests', async() => {
    const { tabRegistry, initTabsIpc } = await load();
    const appWindow = { session: appSession };
    const guestPage = { session: browserSession };
    mockAllWebContents.push(appWindow, guestPage);

    initTabsIpc();
    tabRegistry.open({ assetId: 'a', url: 'https://a.example', origin: 'user' });
    await nextTick();

    const recipients = mockSafeSend.mock.calls.map(call => call[0]);
    expect(recipients).toContain(appWindow);
    expect(recipients).not.toContain(guestPage);
  });
});
