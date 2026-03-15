import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockGetWorkflow: any = jest.fn();
const mockUpdateWorkflow: any = jest.fn();

jest.unstable_mockModule('../../../services/N8nService', () => ({
  createN8nService: jest.fn(async() => ({
    getWorkflow:    mockGetWorkflow,
    updateWorkflow: mockUpdateWorkflow,
  })),
}));

async function loadUpdateTool() {
  return import('../update_workflow');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('update_workflow tool payload sanitization', () => {
  afterEach(() => {
    mockGetWorkflow.mockReset();
    mockUpdateWorkflow.mockReset();
  });

  it('does not include shared by default when caller only updates name', async() => {
    const { UpdateWorkflowWorker, updateWorkflowRegistration } = await loadUpdateTool();

    mockGetWorkflow.mockResolvedValueOnce({
      id:          'wf-1',
      name:        'Existing Name',
      active:      false,
      nodes:       [{ id: '1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
      settings:    {},
      shared:      [{ project: { id: 'proj-1', name: 'Default Project' } }],
    });

    mockUpdateWorkflow.mockResolvedValueOnce({
      id:          'wf-1',
      name:        'Updated Name',
      active:      false,
      updatedAt:   new Date().toISOString(),
      nodes:       [],
      connections: {},
      tags:        [],
      owner:       null,
    });

    const worker = configureWorker(new UpdateWorkflowWorker(), updateWorkflowRegistration);
    const result = await worker.invoke({ id: 'wf-1', name: 'Updated Name' });

    expect(result.success).toBe(true);
    expect(mockUpdateWorkflow).toHaveBeenCalledWith(
      'wf-1',
      expect.not.objectContaining({ shared: expect.anything() }),
    );
  });

  it('strips shared[].project.id when shared is explicitly provided', async() => {
    const { UpdateWorkflowWorker, updateWorkflowRegistration } = await loadUpdateTool();

    mockGetWorkflow.mockResolvedValueOnce({
      id:          'wf-2',
      name:        'Existing',
      active:      false,
      nodes:       [{ id: '1', name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }],
      connections: {},
      settings:    {},
    });

    mockUpdateWorkflow.mockResolvedValueOnce({
      id:          'wf-2',
      name:        'Existing',
      active:      false,
      updatedAt:   new Date().toISOString(),
      nodes:       [],
      connections: {},
      tags:        [],
      owner:       null,
    });

    const worker = configureWorker(new UpdateWorkflowWorker(), updateWorkflowRegistration);
    const result = await worker.invoke({
      id:     'wf-2',
      shared: [
        {
          role:    'workflow:owner',
          project: { id: 'proj-readonly', name: 'Main' },
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(mockUpdateWorkflow).toHaveBeenCalledWith(
      'wf-2',
      expect.objectContaining({
        shared: [
          {
            role:    'workflow:owner',
            project: { name: 'Main' },
          },
        ],
      }),
    );
  });
});
