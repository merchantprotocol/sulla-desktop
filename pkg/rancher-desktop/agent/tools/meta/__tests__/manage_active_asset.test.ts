import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockPersona = {
  registerIframeAsset:   jest.fn(),
  registerDocumentAsset: jest.fn(),
  removeAsset:           jest.fn(),
};

const mockRegistry = {
  getOrCreatePersonaService: jest.fn(() => mockPersona),
};

jest.unstable_mockModule('../../../database/registry/AgentPersonaRegistry', () => ({
  getAgentPersonaRegistry: () => mockRegistry,
}));

async function loadModule() {
  return import('../manage_active_asset');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('manage_active_asset tool', () => {
  afterEach(() => {
    mockPersona.registerIframeAsset.mockReset();
    mockPersona.registerDocumentAsset.mockReset();
    mockPersona.removeAsset.mockReset();
    mockRegistry.getOrCreatePersonaService.mockClear();
  });

  it('upserts workflow iframe asset using stable id and mutable url', async() => {
    const { ManageActiveAssetWorker, manageActiveAssetRegistration } = await loadModule();
    const worker = configureWorker(new ManageActiveAssetWorker(), manageActiveAssetRegistration);
    worker.setState({ metadata: { wsChannel: 'sulla-desktop' } });

    const result = await worker.invoke({
      action:    'upsert',
      assetType: 'iframe',
      assetId:   'sulla_n8n',
      skillSlug: 'workflow_automation',
      url:       'http://127.0.0.1:30119/home/workflows/abc123',
      title:     'Sulla n8n',
      active:    true,
      collapsed: true,
    });

    expect(result.success).toBe(true);
    expect(mockRegistry.getOrCreatePersonaService as any).toHaveBeenCalledWith('sulla-desktop');
    expect(mockPersona.registerIframeAsset).toHaveBeenCalledWith(expect.objectContaining({
      id:        'sulla_n8n',
      skillSlug: 'workflow_automation',
      url:       'http://127.0.0.1:30119/home/workflows/abc123',
    }));
  });

  it('upserts document active asset content', async() => {
    const { ManageActiveAssetWorker, manageActiveAssetRegistration } = await loadModule();
    const worker = configureWorker(new ManageActiveAssetWorker(), manageActiveAssetRegistration);
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

    expect(result.success).toBe(true);
    expect(mockPersona.registerDocumentAsset).toHaveBeenCalledWith(expect.objectContaining({
      id:      'planning-prd',
      content: '<h3>Plan</h3><p>Build workflow</p>',
    }));
  });

  it('removes existing active asset by id', async() => {
    const { ManageActiveAssetWorker, manageActiveAssetRegistration } = await loadModule();
    const worker = configureWorker(new ManageActiveAssetWorker(), manageActiveAssetRegistration);
    worker.setState({ metadata: { wsChannel: 'sulla-desktop' } });

    const result = await worker.invoke({ action: 'remove', assetId: 'sulla_n8n' });

    expect(result.success).toBe(true);
    expect(mockPersona.removeAsset).toHaveBeenCalledWith('sulla_n8n');
  });
});
