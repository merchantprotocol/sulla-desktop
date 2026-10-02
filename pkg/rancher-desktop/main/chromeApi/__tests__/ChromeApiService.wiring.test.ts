/**
 * @jest-environment node
 */
import { EventEmitter } from 'events';

import { describe, expect, it, jest } from '@jest/globals';

const mockSession: any = new EventEmitter();
mockSession.downloadURL = jest.fn();
mockSession.cookies = {};

const mockRegistry = {
  list:             jest.fn((): any[] => []),
  open:             jest.fn((_input: unknown) => undefined),
  close:            jest.fn((_assetId: string) => true),
  getActiveAssetId: jest.fn((): string | null => null),
};

jest.unstable_mockModule('electron', () => ({
  BrowserWindow:   { getAllWindows: jest.fn(() => []) },
  default:         {},
  WebContentsView: jest.fn(),
  session:         { fromPartition: jest.fn(() => mockSession) },
}));
jest.unstable_mockModule('@pkg/main/browserTabs/TabRegistry', () => ({ tabRegistry: mockRegistry }));
jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: { sulla: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } },
}));
jest.unstable_mockModule('@pkg/window/browserTabViewManager', () => ({ BrowserTabViewManager: {} }));

function makeWebContents() {
  const wc: any = new EventEmitter();
  wc.getURL = () => 'https://example.com/page';
  wc.getTitle = () => 'Example';
  wc.insertCSS = jest.fn(() => Promise.resolve('key'));

  return wc;
}

function makeManager() {
  const created: ((tabId: string, wc: any) => void)[] = [];

  return {
    created,
    getWebRequestFixer: jest.fn(() => ({ on: jest.fn() })),
    onViewCreated:      jest.fn((fn: (tabId: string, wc: any) => void) => { created.push(fn); return () => {} }),
    getWebContents:     jest.fn(() => null as any),
    wakeView:           jest.fn(),
    setFocusedTab:      jest.fn(),
    getFocusedTab:      jest.fn(() => null),
    destroyView:        jest.fn(),
    createView:         jest.fn(),
  };
}

async function freshApi() {
  jest.resetModules();
  const { ChromeApiService } = await import('../ChromeApiService');
  (ChromeApiService as any).instance = undefined;
  const manager = makeManager();

  return { api: ChromeApiService.getInstance(manager as any) as any, manager };
}

describe('ChromeApiService wiring', () => {
  it('attaches chrome.webNavigation to every tab view so events fire', async() => {
    const { api, manager } = await freshApi();
    const wc = makeWebContents();
    const onBefore = jest.fn();
    const onCommitted = jest.fn();
    api.webNavigation.onBeforeNavigate.addListener(onBefore);
    api.webNavigation.onCommitted.addListener(onCommitted);

    expect(manager.onViewCreated).toHaveBeenCalled();
    manager.created[0]('tab-1', wc);

    // loadURL / address-bar navigations never fire will-navigate — they must still count.
    wc.emit('did-start-navigation', { url: 'https://example.com/next', isMainFrame: true, isSameDocument: false });
    wc.emit('did-start-navigation', { url: 'https://example.com/next#a', isMainFrame: true, isSameDocument: true });
    wc.emit('did-navigate', {}, 'https://example.com/next');

    expect(onBefore).toHaveBeenCalledTimes(1);
    expect(onBefore.mock.calls[0][0]).toMatchObject({ tabId: 'tab-1', url: 'https://example.com/next' });
    expect(onCommitted).toHaveBeenCalledTimes(1);
  });

  it('creates and removes visible tabs through the TabRegistry', async() => {
    const { api, manager } = await freshApi();

    const tab = await api.tabs.create({ url: 'https://example.com/', active: false });
    expect(mockRegistry.open).toHaveBeenCalledWith({ assetId: tab.id, url: 'https://example.com/', origin: 'agent' });
    expect(manager.createView).not.toHaveBeenCalled();

    await api.tabs.remove(tab.id);
    expect(mockRegistry.close).toHaveBeenCalledWith(tab.id);
    expect(manager.destroyView).not.toHaveBeenCalled();
  });

  it('inserts CSS natively (CSP-proof) instead of injecting a <style> tag', async() => {
    const { api, manager } = await freshApi();
    const wc = makeWebContents();
    manager.getWebContents.mockReturnValue(wc);

    await api.scripting.insertCSS({ target: { tabId: 'tab-1' }, css: 'body{color:red}' });

    expect(wc.insertCSS).toHaveBeenCalledWith('body{color:red}');
    expect(manager.wakeView).toHaveBeenCalledWith('tab-1');
  });

  it('downloads in the browser session and only claims the matching download', async() => {
    const { api } = await freshApi();
    const changed = jest.fn();
    api.downloads.onChanged.addListener(changed);

    const id = await api.downloads.download({ url: 'https://example.com/file.zip' });
    expect(mockSession.downloadURL).toHaveBeenCalledWith('https://example.com/file.zip');

    const makeItem = (url: string) => {
      const item: any = new EventEmitter();
      Object.assign(item, {
        getURL:           () => url,
        getURLChain:      () => [url],
        getTotalBytes:    () => 10,
        getFilename:      () => 'file.zip',
        getReceivedBytes: () => 10,
        setSavePath:      jest.fn(),
        cancel:           jest.fn(),
        pause:            jest.fn(),
        resume:           jest.fn(),
        canResume:        () => true,
      });
      return item;
    };
    const unrelated = makeItem('https://other.example/user-download.pdf');
    mockSession.emit('will-download', {}, unrelated);
    const ours = makeItem('https://example.com/file.zip');
    mockSession.emit('will-download', {}, ours);

    await api.downloads.pause(id);
    expect(ours.pause).toHaveBeenCalled();
    expect(unrelated.pause).not.toHaveBeenCalled();
    await api.downloads.resume(id);
    expect(ours.resume).toHaveBeenCalled();

    ours.emit('done', {}, 'completed');
    const [item] = await api.downloads.search({});
    expect(item).toMatchObject({ id, state: 'complete', filename: 'file.zip' });
  });
});
