import { describe, expect, it, jest } from '@jest/globals';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });

  return { promise, resolve: complete };
}

const events: string[] = [];
const captures: Deferred<{ base64: string; mediaType: string } | null>[] = [];
let destroyed = false;
let bounds = { x: 0, y: 0, width: 0, height: 0 };
let throttled = true;

const webContents = {
  session:                 {},
  loadURL:                 jest.fn(async() => {}),
  on:                      jest.fn(),
  getURL:                  jest.fn(() => 'https://example.com'),
  getTitle:                jest.fn(() => 'Example'),
  isLoading:               jest.fn(() => false),
  isDestroyed:             jest.fn(() => destroyed),
  getBackgroundThrottling: jest.fn(() => throttled),
  setBackgroundThrottling: jest.fn((value: boolean) => {
    events.push(`throttle:${ value }`);
    throttled = value;
  }),
  close: jest.fn(() => {
    events.push('close');
    destroyed = true;
  }),
};

const view = {
  webContents,
  getBounds: jest.fn(() => ({ ...bounds })),
  setBounds: jest.fn((next: Electron.Rectangle) => {
    events.push(`bounds:${ next.x },${ next.y },${ next.width },${ next.height }`);
    bounds = { ...next };
  }),
};

const mainWindow = {
  isDestroyed: jest.fn(() => false),
  contentView: {
    addChildView:    jest.fn(() => events.push('attach')),
    removeChildView: jest.fn(() => events.push('detach')),
  },
};

Object.defineProperty(globalThis, 'require', {
  configurable: true,
  value:        jest.fn((specifier: string) => {
    if (specifier === '@pkg/window') return { getWindow: () => mainWindow };
    throw new Error(`Unexpected require: ${ specifier }`);
  }),
});

jest.unstable_mockModule('electron', () => ({
  BrowserWindow:   { getAllWindows: jest.fn(() => []) },
  default:         {},
  session:         { fromPartition: jest.fn(() => webContents.session) },
  WebContentsView: jest.fn(() => view),
}));

jest.unstable_mockModule('@pkg/main/browserTabs/browserSession', () => ({
  getBrowserSession: jest.fn(() => webContents.session),
}));

jest.unstable_mockModule('@pkg/main/browserTabs/GuestBridge', () => ({
  GuestBridge: class {
    captureScreenshot(): Promise<{ base64: string; mediaType: string } | null> {
      const capture = deferred<{ base64: string; mediaType: string } | null>();
      const index = captures.push(capture) - 1;

      events.push(`capture:${ index }:start`);
      return capture.promise.finally(() => events.push(`capture:${ index }:end`));
    }
  },
}));

jest.unstable_mockModule('@pkg/main/browserTabs/TabRegistry', () => ({
  tabRegistry: {
    close:            jest.fn(() => false),
    getActiveAssetId: jest.fn(() => null),
    list:             jest.fn(() => []),
    open:             jest.fn(),
  },
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

jest.unstable_mockModule('@pkg/window', () => ({
  getWindow: jest.fn(() => mainWindow),
}));

jest.unstable_mockModule('@pkg/window/browserTabViewManager', () => ({
  BrowserTabViewManager: {},
}));

describe('ChromeApiService hidden-tab capture lifecycle', () => {
  it('serializes overlapping captures and defers close until capture cleanup completes', async() => {
    const { ChromeApiService } = await import('../ChromeApiService');
    const manager = {
      destroyView:         jest.fn(),
      getFocusedTab:       jest.fn(() => null),
      getWebContents:      jest.fn(() => null),
      getWebRequestFixer:  jest.fn(() => ({ on: jest.fn() })),
      onViewCreated:       jest.fn(),
      setFocusedTab:       jest.fn(),
    };
    const api = ChromeApiService.getInstance(manager as any);
    const tab = await api.tabs.create({ url: 'https://example.com', hidden: true });
    const firstCapture = api.captureHiddenTabScreenshot(tab.id);

    await Promise.resolve();
    const secondCapture = api.captureHiddenTabScreenshot(tab.id);
    const close = api.tabs.remove(tab.id);

    await Promise.resolve();
    expect(captures).toHaveLength(1);
    expect(webContents.close).not.toHaveBeenCalled();

    captures[0].resolve({ base64: 'first', mediaType: 'image/jpeg' });
    await firstCapture;
    await Promise.resolve();
    await Promise.resolve();

    expect(captures).toHaveLength(2);
    expect(webContents.close).not.toHaveBeenCalled();

    captures[1].resolve({ base64: 'second', mediaType: 'image/jpeg' });
    await secondCapture;
    await close;

    expect(events.filter(event => event === 'attach')).toHaveLength(2);
    expect(events.filter(event => event === 'detach')).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      'capture:0:start',
      'capture:0:end',
      'capture:1:start',
      'capture:1:end',
      'close',
    ]));
    expect(events.indexOf('capture:0:end')).toBeLessThan(events.indexOf('capture:1:start'));
    const closeIndex = events.indexOf('close');

    expect(events.lastIndexOf('detach')).toBeLessThan(closeIndex);
    expect(events.lastIndexOf('bounds:0,0,1280,800')).toBeLessThan(closeIndex);
    expect(events.lastIndexOf('throttle:true')).toBeLessThan(closeIndex);
    expect(bounds).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
    expect(throttled).toBe(true);
    expect(await api.tabs.get(tab.id)).toBeNull();
  });
});
