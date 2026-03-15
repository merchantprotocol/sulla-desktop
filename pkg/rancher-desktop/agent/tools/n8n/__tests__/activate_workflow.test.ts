import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockActivateWorkflow: any = jest.fn();

jest.unstable_mockModule('../../../services/N8nService', () => ({
  createN8nService: jest.fn(async() => ({
    activateWorkflow: mockActivateWorkflow,
  })),
}));

async function loadActivateTool() {
  return import('../activate_workflow');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('activate_workflow tool payload', () => {
  afterEach(() => {
    mockActivateWorkflow.mockReset();
  });

  it('forwards only allowed activation payload fields to service', async() => {
    const { ActivateWorkflowWorker, activateWorkflowRegistration } = await loadActivateTool();

    mockActivateWorkflow.mockResolvedValueOnce({
      id:          'activation-1',
      name:        'Workflow Name',
      description: 'Workflow Description',
      createdAt:   new Date().toISOString(),
    });

    const worker = configureWorker(new ActivateWorkflowWorker(), activateWorkflowRegistration);
    const result = await worker.invoke({
      id:        'workflow-123',
      versionId: 'version-abc',
    });

    expect(result.success).toBe(true);
    expect(mockActivateWorkflow).toHaveBeenCalledWith('workflow-123', { versionId: 'version-abc' });
  });

  it('omits activation options when versionId is empty', async() => {
    const { ActivateWorkflowWorker, activateWorkflowRegistration } = await loadActivateTool();

    mockActivateWorkflow.mockResolvedValueOnce({
      id:        'activation-2',
      createdAt: new Date().toISOString(),
    });

    const worker = configureWorker(new ActivateWorkflowWorker(), activateWorkflowRegistration);
    const result = await worker.invoke({
      id:        'workflow-123',
      versionId: '   ',
    });

    expect(result.success).toBe(true);
    expect(mockActivateWorkflow).toHaveBeenCalledWith('workflow-123', undefined);
  });
});
