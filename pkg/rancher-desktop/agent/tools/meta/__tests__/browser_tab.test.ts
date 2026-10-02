import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { browserToolManifests } from '../../browser/manifests';
const browserTabRegistration = browserToolManifests.find((manifest: any) => manifest.name === 'tab');

const mockBridge = {
  getPageTitle: jest.fn(async() => 'Sulla'),
  getPageUrl:   jest.fn(async() => 'https://example.com'),
  execInPage:   jest.fn(async() => null),
};
const mockTabRegistry = {
  open:        jest.fn(),
  close:       jest.fn<(id: string) => boolean>(() => true),
  bridge:      jest.fn(() => mockBridge),
  assertOwner: jest.fn(),
};
jest.unstable_mockModule('../../../services/DecisionService', () => ({ decisionService: { requiresApproval: jest.fn<() => Promise<boolean>>().mockResolvedValue(false) } }));

jest.unstable_mockModule('@pkg/main/browserTabs/TabRegistry', () => ({
  tabRegistry: mockTabRegistry,
}));

async function loadModule() {
  return import('../../browser/tab');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('browser_tab tool', () => {
  afterEach(() => {
    mockTabRegistry.open.mockReset();
    mockTabRegistry.close.mockClear();
    mockTabRegistry.bridge.mockClear();
  });

  it('opens a browser tab using the supplied stable id and url', async() => {
    const { BrowserTabWorker } = await loadModule();
    const worker = configureWorker(new BrowserTabWorker(), browserTabRegistration);
    worker.setState({ metadata: { wsChannel: 'sulla-desktop' } });

    const result = await worker.invoke({
      action:    'upsert',
      assetType: 'browser',
      assetId:   'sulla_n8n',
      url:       'https://example.com/workflows/abc123',
      title:     'Sulla n8n',
      active:    true,
      collapsed: true,
    });

    expect(result.success).toBe(true);
    expect(mockTabRegistry.open).toHaveBeenCalledWith(expect.objectContaining({
      assetId: 'sulla_n8n',
      url:     'https://example.com/workflows/abc123',
      origin:  'agent',
    }));
  });

  it('rejects the removed document asset type', async() => {
    const { BrowserTabWorker } = await loadModule();
    const worker = configureWorker(new BrowserTabWorker(), browserTabRegistration);
    worker.setState({ metadata: { wsChannel: 'sulla-desktop' } });

    const result = await worker.invoke({
      action:    'upsert',
      assetType: 'document',
      assetId:   'planning-prd',
      title:     'Planning PRD',
      content:   '<h3>Plan</h3><p>Build workflow</p>',
      active:    true,
      collapsed: true,
    });

    expect(result.success).toBe(false);
    expect(result.result).toContain('Document rendering was removed');
  });

  it('removes existing active asset by id', async() => {
    const { BrowserTabWorker } = await loadModule();
    const worker = configureWorker(new BrowserTabWorker(), browserTabRegistration);
    worker.setState({ metadata: { wsChannel: 'sulla-desktop' } });

    const result = await worker.invoke({ action: 'remove', assetId: 'sulla_n8n' });

    expect(result.success).toBe(true);
    expect(mockTabRegistry.close).toHaveBeenCalledWith('sulla_n8n');
  });
});
