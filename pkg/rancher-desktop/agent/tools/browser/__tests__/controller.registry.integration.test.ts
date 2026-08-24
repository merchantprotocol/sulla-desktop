import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

const views = new Map<string, {
  executeJavaScript: jest.Mock<(code: string) => Promise<unknown>>;
  loadURL:           jest.Mock<() => Promise<void>>;
}>();
const createView = jest.fn((assetId: string) => {
  views.set(assetId, {
    executeJavaScript: jest.fn((code: string) => {
      if (code === 'document.title') return Promise.resolve('Local test');
      if (code === 'location.href') return Promise.resolve('http://127.0.0.1:5173/settings');
      return Promise.resolve(null);
    }),
    loadURL: jest.fn(() => Promise.resolve()),
  });
});
const destroyView = jest.fn((assetId: string) => views.delete(assetId));

jest.unstable_mockModule('@pkg/window/browserTabViewManager', () => ({
  BrowserTabViewManager: {
    getInstance: () => ({
      createView,
      destroyView,
      getWebContents: (assetId: string) => views.get(assetId) ?? null,
    }),
  },
}));

let GraphBrowserControllerWorker: typeof import('../controller').GraphBrowserControllerWorker;
let browserToolManifests: typeof import('../manifests').browserToolManifests;
let tabRegistry: typeof import('@pkg/main/browserTabs/TabRegistry').tabRegistry;
let toolRegistry: typeof import('../../registry').toolRegistry;
let browserAssetId: typeof import('../../../utils/graphBrowserController').browserAssetId;

function state(threadId: string) {
  return {
    metadata: {
      graphNativeBrowserController: true,
      userVisibleBrowser:           true,
      threadId,
      allowedToolNames:             ['browser_controller'],
    },
  } as any;
}

function controller(): InstanceType<typeof GraphBrowserControllerWorker> {
  const manifest = browserToolManifests.find(item => item.name === 'browser_controller')!;
  const worker = new GraphBrowserControllerWorker();
  worker.name = manifest.name;
  worker.description = manifest.description;
  worker.schemaDef = manifest.schemaDef;
  return worker;
}

describe('graph Browser controller ownership at the production registry boundary', () => {
  beforeAll(async() => {
    ({ GraphBrowserControllerWorker } = await import('../controller'));
    ({ browserToolManifests } = await import('../manifests'));
    ({ tabRegistry } = await import('@pkg/main/browserTabs/TabRegistry'));
    ({ toolRegistry } = await import('../../registry'));
    ({ browserAssetId } = await import('../../../utils/graphBrowserController'));
    toolRegistry.registerManifests(browserToolManifests);
  });

  afterEach(() => {
    for (const tab of tabRegistry.list()) tabRegistry.close(tab.assetId);
    views.clear();
    jest.clearAllMocks();
  });

  it('opens through the real controller, tool loader, tab worker, and registry, then rejects a colliding graph before navigation', async() => {
    const sharedSuffix = '123456789012345678901234';
    const sharedSlugPrefix = 'a'.repeat(60);
    const first = controller();
    const firstResult = await first.invoke({
      tool: 'tab',
      args: { action: 'upsert', url: `http://127.0.0.1:5173/${ sharedSlugPrefix }-first` },
    }, state(`first-${ sharedSuffix }`));

    expect(firstResult.success).toBe(true);
    const [record] = tabRegistry.list();
    expect(record.owner).toEqual({ kind: 'graph', sessionId: `graph:first-${ sharedSuffix }` });
    expect(createView).toHaveBeenCalledTimes(1);

    const existingView = views.get(record.assetId)!;
    const createTool = jest.spyOn(toolRegistry, 'createTool');
    const secondResult = await controller().invoke({
      tool: 'tab',
      args: { action: 'upsert', url: `http://127.0.0.1:5173/${ sharedSlugPrefix }-second` },
    }, state(`second-${ sharedSuffix }`));

    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toContain('different browser session');
    expect(createTool).not.toHaveBeenCalled();
    expect(existingView.loadURL).not.toHaveBeenCalled();
    expect(tabRegistry.get(record.assetId)?.url).toBe(`http://127.0.0.1:5173/${ sharedSlugPrefix }-first`);
  });

  it('rejects an existing user tab with the deterministic graph asset ID before loading a browser worker', async() => {
    const threadId = 'heartbeat-user-collision';
    const targetUrl = 'http://127.0.0.1:5173/settings';
    const assetId = browserAssetId(threadId, targetUrl);
    tabRegistry.open({
      assetId,
      url:    'http://127.0.0.1:5173/user-private',
      origin: 'user',
    });
    const existingView = views.get(assetId)!;
    const createTool = jest.spyOn(toolRegistry, 'createTool');

    const result = await controller().invoke({
      tool: 'tab',
      args: { action: 'upsert', url: targetUrl },
    }, state(threadId));

    expect(result.success).toBe(false);
    expect(result.error).toContain('different browser session');
    expect(createTool).not.toHaveBeenCalled();
    expect(existingView.loadURL).not.toHaveBeenCalled();
    expect(tabRegistry.get(assetId)?.url).toBe('http://127.0.0.1:5173/user-private');
  });
});
