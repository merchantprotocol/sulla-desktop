import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';

import { beforeAll, describe, expect, it, jest } from '@jest/globals';

let createN8nServiceFn: any;

const baseWorkflowGraph = {
  nodes: [
    {
      id:          '1',
      name:        'Manual Trigger',
      type:        'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position:    [240, 300],
      parameters:  {},
    },
  ],
  connections: {},
  settings:    {},
};

const createActivatableGraph = (suffix: string) => ({
  nodes: [
    {
      id:          '1',
      name:        'Webhook Trigger',
      type:        'n8n-nodes-base.webhook',
      typeVersion: 2,
      position:    [240, 300],
      parameters:  {
        httpMethod:   'GET',
        path:         `it-update-workflow-${ suffix }`,
        responseMode: 'onReceived',
      },
    },
  ],
  connections: {},
  settings:    {},
});

describe('N8nService.updateWorkflow', () => {
  beforeAll(async() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;

    if (!(globalThis as any).fetch) {
      const nodeFetch = await import('node-fetch');
      (globalThis as any).fetch = nodeFetch.default;
    }

    const settingsDir = await mkdtemp(join(tmpdir(), 'sulla-settings-'));
    const fallbackPath = join(settingsDir, 'installation-lock.json');
    await writeFile(fallbackPath, '{}', 'utf8');

    const settingsMod = await import('../../database/models/SullaSettingsModel');
    settingsMod.SullaSettingsModel.setFallbackFilePath(fallbackPath);
    await settingsMod.SullaSettingsModel.bootstrap();

    const mod = await import('../N8nService');
    createN8nServiceFn = mod.createN8nService;

    // Use production lifecycle to ensure the API key material is fresh and valid.
    const bootstrapService = await createN8nServiceFn();
    await bootstrapService.refreshApiKey();
  });

  it('updates inactive workflow in live environment', async() => {
    const service = await createN8nServiceFn();
    const workflowName = `it-update-inactive-${ Date.now() }`;
    const updatedName = `${ workflowName }-updated`;

    const created = await service.createWorkflow({
      name: workflowName,
      ...baseWorkflowGraph,
    });

    try {
      const result = await service.updateWorkflow(created.id, {
        name:        updatedName,
        active:      true,
        nodes:       created.nodes,
        connections: created.connections,
        settings:    created.settings || {},
      });

      const fetched = await service.getWorkflow(created.id, true);

      expect(result.id).toBe(created.id);
      expect(fetched.name).toBe(updatedName);
      expect(fetched.active).toBe(false);
    } finally {
      await service.deleteWorkflow(created.id);
    }
  }, 30000);

  it('deactivates, updates, and reactivates active workflow in live environment', async() => {
    const service = await createN8nServiceFn();
    const workflowName = `it-update-active-${ Date.now() }`;
    const updatedName = `${ workflowName }-updated`;
    const activatableGraph = createActivatableGraph(String(Date.now()));

    const created = await service.createWorkflow({
      name: workflowName,
      ...activatableGraph,
    });

    try {
      await service.activateWorkflow(created.id);

      const result = await service.updateWorkflow(created.id, {
        name:        updatedName,
        nodes:       created.nodes,
        connections: created.connections,
        settings:    created.settings || {},
      });

      const fetched = await service.getWorkflow(created.id, true);

      expect(result.id).toBe(created.id);
      expect(fetched.name).toBe(updatedName);
      expect(fetched.active).toBe(true);
    } finally {
      try {
        await service.deactivateWorkflow(created.id);
      } catch {
        // ignore cleanup deactivation errors
      }
      await service.deleteWorkflow(created.id);
    }
  }, 45000);
});
