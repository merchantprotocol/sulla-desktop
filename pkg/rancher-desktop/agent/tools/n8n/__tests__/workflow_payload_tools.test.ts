import { TextDecoder, TextEncoder } from 'node:util';
import { beforeAll, describe, expect, it } from '@jest/globals';

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

async function loadN8nTools() {
  const createModule = await import('../create_workflow');
  const updateModule = await import('../update_workflow');
  const validateModule = await import('../validate_workflow_payload');
  return {
    createModule,
    updateModule,
    validateModule,
  };
}

const validPayload = {
  name:  'workflow-payload-tool-test',
  nodes: [
    {
      id:          'node-1',
      name:        'Manual Trigger',
      type:        'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position:    [220, 280],
      parameters:  {},
    },
  ],
  connections: {},
  settings:    {},
};

describe('n8n workflow payload tools', () => {
  beforeAll(() => {
    (globalThis as any).TextEncoder = TextEncoder;
    (globalThis as any).TextDecoder = TextDecoder;
  });

  it('validate_workflow_payload accepts object-form payloads', async() => {
    const { validateModule } = await loadN8nTools();
    const worker = configureWorker(new validateModule.ValidateWorkflowPayloadWorker(), validateModule.validateWorkflowPayloadRegistration);

    const result = await worker.invoke({
      ...validPayload,
      checkConnection: false,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const parsed = JSON.parse(result.result as string);
    expect(parsed.valid).toBe(true);
    expect(parsed.nodeCount).toBe(1);
  });

  it('validate_workflow_payload accepts JSON-string payloads', async() => {
    const { validateModule } = await loadN8nTools();
    const worker = configureWorker(new validateModule.ValidateWorkflowPayloadWorker(), validateModule.validateWorkflowPayloadRegistration);

    const result = await worker.invoke({
      name:            validPayload.name,
      nodes:           JSON.stringify(validPayload.nodes),
      connections:     JSON.stringify(validPayload.connections),
      settings:        JSON.stringify(validPayload.settings),
      checkConnection: false,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const parsed = JSON.parse(result.result as string);
    expect(parsed.valid).toBe(true);
    expect(parsed.connectionKeys).toEqual([]);
  });

  it('create_workflow no longer fails upfront schema validation for object payload fields', async() => {
    const { createModule } = await loadN8nTools();
    const worker = configureWorker(new createModule.CreateWorkflowWorker(), createModule.createWorkflowRegistration);

    const result = await worker.invoke(validPayload);

    // We only assert that schema parsing succeeded (no parseInput failure path).
    expect(result.error).toBeUndefined();
    if (!result.success) {
      expect(result.result as string).not.toContain('Input validation failed');
      expect(result.result as string).not.toContain('Missing required field: nodes');
      expect(result.result as string).not.toContain('Missing required field: connections');
    }
  });

  it('create_workflow does not require settings at schema layer', async() => {
    const { createModule } = await loadN8nTools();
    const worker = configureWorker(new createModule.CreateWorkflowWorker(), createModule.createWorkflowRegistration);

    const { settings: _settings, ...payloadWithoutSettings } = validPayload;
    const result = await worker.invoke(payloadWithoutSettings);

    expect(result.error).toBeUndefined();
    if (!result.success) {
      expect(result.result as string).not.toContain('Missing required field: settings');
      expect(result.result as string).not.toContain('Input validation failed');
    }
  });

  it('update_workflow no longer fails upfront schema validation for object payload fields', async() => {
    const { updateModule } = await loadN8nTools();
    const worker = configureWorker(new updateModule.UpdateWorkflowWorker(), updateModule.updateWorkflowRegistration);

    const result = await worker.invoke({
      id: 'workflow-id-placeholder',
      ...validPayload,
    });

    expect(result.error).toBeUndefined();
    if (!result.success) {
      expect(result.result as string).not.toContain('Input validation failed');
      expect(result.result as string).not.toContain('Missing required field: nodes');
      expect(result.result as string).not.toContain('Missing required field: connections');
    }
  });

  it('update_workflow does not require settings at schema layer', async() => {
    const { updateModule } = await loadN8nTools();
    const worker = configureWorker(new updateModule.UpdateWorkflowWorker(), updateModule.updateWorkflowRegistration);

    const { settings: _settings, ...payloadWithoutSettings } = validPayload;
    const result = await worker.invoke({
      id: 'workflow-id-placeholder',
      ...payloadWithoutSettings,
    });

    expect(result.error).toBeUndefined();
    if (!result.success) {
      expect(result.result as string).not.toContain('Missing required field: settings');
      expect(result.result as string).not.toContain('Input validation failed');
    }
  });

  it('update_workflow preserves active field in validated payload', async() => {
    const { updateModule } = await loadN8nTools();
    const worker = configureWorker(new updateModule.UpdateWorkflowWorker(), updateModule.updateWorkflowRegistration);

    const parsed = worker.parseInput({
      id:     'workflow-id-placeholder',
      active: true,
      ...validPayload,
    });

    expect(parsed.active).toBe(true);
  });

  it('update_workflow accepts minimal payload at schema layer (id only)', async() => {
    const { updateModule } = await loadN8nTools();
    const worker = configureWorker(new updateModule.UpdateWorkflowWorker(), updateModule.updateWorkflowRegistration);

    const parsed = worker.parseInput({
      id: 'workflow-id-placeholder',
    });

    expect(parsed.id).toBe('workflow-id-placeholder');
    expect(parsed.nodes).toBeUndefined();
    expect(parsed.connections).toBeUndefined();
  });

  it('create_workflow normalizes non-none saveDataSuccessExecution values to all', async() => {
    const { createModule } = await loadN8nTools();
    const worker = configureWorker(new createModule.CreateWorkflowWorker(), createModule.createWorkflowRegistration);

    const normalizedAll = worker.normalizeWorkflowPayload({
      ...validPayload,
      settings: {
        saveDataSuccessExecution: 'all',
      },
    });
    expect(normalizedAll.settings.saveDataSuccessExecution).toBe('all');

    const normalizedFromLegacyValue = worker.normalizeWorkflowPayload({
      ...validPayload,
      settings: {
        saveDataSuccessExecution: 'last',
      },
    });
    expect(normalizedFromLegacyValue.settings.saveDataSuccessExecution).toBe('all');
  });

  it('update_workflow normalizes non-none saveDataSuccessExecution values to all', async() => {
    const { updateModule } = await loadN8nTools();
    const worker = configureWorker(new updateModule.UpdateWorkflowWorker(), updateModule.updateWorkflowRegistration);

    const stubService = {
      getWorkflow: async() => ({
        id:          'workflow-id-placeholder',
        name:        'Existing Workflow',
        active:      false,
        nodes:       validPayload.nodes,
        connections: validPayload.connections,
        settings:    {},
      }),
    };

    const normalizedNone = await worker.normalizeWorkflowPayload({
      id:       'workflow-id-placeholder',
      settings: {
        saveDataSuccessExecution: 'none',
      },
    }, stubService);
    expect(normalizedNone.workflowData.settings.saveDataSuccessExecution).toBe('none');

    const normalizedFromLegacyValue = await worker.normalizeWorkflowPayload({
      id:       'workflow-id-placeholder',
      settings: {
        saveDataSuccessExecution: 'last',
      },
    }, stubService);
    expect(normalizedFromLegacyValue.workflowData.settings.saveDataSuccessExecution).toBe('all');
  });
});
