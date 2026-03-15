import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockGetWorkflow: any = jest.fn();
const mockUpdateWorkflow: any = jest.fn();

jest.unstable_mockModule('../../../services/N8nService', () => ({
  createN8nService: jest.fn(async() => ({
    getWorkflow:    mockGetWorkflow,
    updateWorkflow: mockUpdateWorkflow,
  })),
}));

async function loadNodeTools() {
  const getModule = await import('../get_workflow_node');
  const listModule = await import('../get_workflow_node_list');
  const patchModule = await import('../patch_workflow');

  return {
    getModule,
    listModule,
    patchModule,
  };
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('n8n workflow node tools', () => {
  afterEach(() => {
    mockGetWorkflow.mockReset();
    mockUpdateWorkflow.mockReset();
  });

  it('adds a node with deterministic id and unique name', async() => {
    const { patchModule } = await loadNodeTools();
    const worker = configureWorker(new patchModule.PatchWorkflowWorker(), patchModule.patchWorkflowRegistration);

    mockGetWorkflow.mockResolvedValueOnce({
      id:    'wf-1',
      name:  'Workflow A',
      nodes: [
        { id: 'trigger-1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
      ],
      connections: {},
      settings:    {},
    });

    mockUpdateWorkflow.mockResolvedValueOnce({ id: 'wf-1' });

    const result = await worker.invoke({
      workflowId: '  wf-1  ',
      operations: [{
        target: 'node',
        op:     'add',
        node:   {
          name:       'Trigger',
          type:       'n8n-nodes-base.httpRequest',
          position:   [240, 0],
          parameters: {},
        },
      }],
    });

    expect(result.success).toBe(true);
    const updateArg = mockUpdateWorkflow.mock.calls[0][1];
    const insertedNode = updateArg.nodes[1];
    expect(mockGetWorkflow).toHaveBeenCalledWith('wf-1', true);
    expect(insertedNode.name).toBe('Trigger (2)');
    expect(insertedNode.type).toBe('n8n-nodes-base.httpRequest');
    expect(String(insertedNode.id)).toMatch(/^trigger-2/);
  });

  it('lists workflow nodes with connection summaries and edges', async() => {
    const { listModule } = await loadNodeTools();
    const worker = configureWorker(new listModule.GetWorkflowNodeListWorker(), listModule.getWorkflowNodeListRegistration);

    mockGetWorkflow.mockResolvedValueOnce({
      id:    'wf-5',
      name:  'Workflow E',
      nodes: [
        { id: 'node-a', name: 'Source', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
        { id: 'node-b', name: 'Target', type: 'n8n-nodes-base.httpRequest', position: [240, 0], parameters: {} },
      ],
      connections: {
        Source: {
          main: [[{ node: 'Target', type: 'main', index: 0 }]],
        },
      },
      settings: {},
    });

    const result = await worker.invoke({
      workflowId:        ' wf-5 ',
      excludePinnedData: true,
    });

    expect(result.success).toBe(true);
    expect(mockGetWorkflow).toHaveBeenCalledWith('wf-5', true);

    const parsed = JSON.parse(result.result as string);
    expect(parsed.nodeCount).toBe(2);
    expect(parsed.nodes[0].nodeName).toBe('Source');
    expect(parsed.nodes[0].outboundConnections).toBe(1);
    expect(parsed.nodes[1].inboundConnections).toBe(1);
    expect(parsed.edges).toEqual([{ fromNode: 'Source', toNode: 'Target' }]);
  });

  it('updates a node name and rewrites connections by node name', async() => {
    const { patchModule } = await loadNodeTools();
    const worker = configureWorker(new patchModule.PatchWorkflowWorker(), patchModule.patchWorkflowRegistration);

    mockGetWorkflow.mockResolvedValueOnce({
      id:    'wf-2',
      name:  'Workflow B',
      nodes: [
        { id: 'node-a', name: 'Source', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
        { id: 'node-b', name: 'Old Name', type: 'n8n-nodes-base.httpRequest', position: [240, 0], parameters: {} },
      ],
      connections: {
        Source: {
          main: [[{ node: 'Old Name', type: 'main', index: 0 }]],
        },
        'Old Name': {
          main: [[]],
        },
      },
      settings: {},
    });

    mockUpdateWorkflow.mockResolvedValueOnce({ id: 'wf-2' });

    const result = await worker.invoke({
      workflowId: 'wf-2',
      operations: [{
        target: 'node',
        op:     'update',
        nodeId: 'node-b',
        patch:  { name: 'New Name' },
      }],
    });

    expect(result.success).toBe(true);
    const updateArg = mockUpdateWorkflow.mock.calls[0][1];
    expect(updateArg.nodes[1].name).toBe('New Name');
    expect(updateArg.connections['Old Name']).toBeUndefined();
    expect(updateArg.connections['New Name']).toBeDefined();
    expect(updateArg.connections.Source.main[0][0].node).toBe('New Name');
  });

  it('removes a node and strips references from connections', async() => {
    const { patchModule } = await loadNodeTools();
    const worker = configureWorker(new patchModule.PatchWorkflowWorker(), patchModule.patchWorkflowRegistration);

    mockGetWorkflow.mockResolvedValueOnce({
      id:    'wf-3',
      name:  'Workflow C',
      nodes: [
        { id: 'node-a', name: 'Source', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
        { id: 'node-b', name: 'Delete Me', type: 'n8n-nodes-base.httpRequest', position: [240, 0], parameters: {} },
      ],
      connections: {
        Source: {
          main: [[{ node: 'Delete Me', type: 'main', index: 0 }]],
        },
        'Delete Me': {
          main: [[{ node: 'Source', type: 'main', index: 0 }]],
        },
      },
      settings: {},
    });

    mockUpdateWorkflow.mockResolvedValueOnce({ id: 'wf-3' });

    const result = await worker.invoke({
      workflowId: 'wf-3',
      operations: [{
        target:   'node',
        op:       'remove',
        nodeName: 'Delete Me',
      }],
    });

    expect(result.success).toBe(true);
    const updateArg = mockUpdateWorkflow.mock.calls[0][1];
    expect(updateArg.nodes).toHaveLength(1);
    expect(updateArg.connections['Delete Me']).toBeUndefined();
    expect(updateArg.connections.Source.main[0]).toEqual([]);
  });

  it('gets a single node with connection counts', async() => {
    const { getModule } = await loadNodeTools();
    const worker = configureWorker(new getModule.GetWorkflowNodeWorker(), getModule.getWorkflowNodeRegistration);

    mockGetWorkflow.mockResolvedValueOnce({
      id:    'wf-4',
      name:  'Workflow D',
      nodes: [
        { id: 'node-a', name: 'Source', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
        { id: 'node-b', name: 'Target', type: 'n8n-nodes-base.httpRequest', position: [240, 0], parameters: {} },
      ],
      connections: {
        Source: {
          main: [[{ node: 'Target', type: 'main', index: 0 }]],
        },
      },
      settings: {},
    });

    const result = await worker.invoke({
      workflowId: 'wf-4',
      nodeId:     'node-b',
    });

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.result as string);
    expect(parsed.node.id).toBe('node-b');
    expect(parsed.connections.inbound).toBe(1);
  });

  it('gets a single node by normalized nodeName match', async() => {
    const { getModule } = await loadNodeTools();
    const worker = configureWorker(new getModule.GetWorkflowNodeWorker(), getModule.getWorkflowNodeRegistration);

    mockGetWorkflow.mockResolvedValueOnce({
      id:    'wf-6',
      name:  'Workflow F',
      nodes: [
        { id: 'node-a', name: 'Source Node', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
        { id: 'node-b', name: 'Merge All Sources', type: 'n8n-nodes-base.merge', position: [240, 0], parameters: {} },
      ],
      connections: {
        'Source Node': {
          main: [[{ node: 'Merge All Sources', type: 'main', index: 0 }]],
        },
      },
      settings: {},
    });

    const result = await worker.invoke({
      workflowId: 'wf-6',
      nodeName:   'merge-all-sources',
    });

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.result as string);
    expect(parsed.node.id).toBe('node-b');
  });

  it('gets a single node by unique partial nodeName match', async() => {
    const { getModule } = await loadNodeTools();
    const worker = configureWorker(new getModule.GetWorkflowNodeWorker(), getModule.getWorkflowNodeRegistration);

    mockGetWorkflow.mockResolvedValueOnce({
      id:    'wf-7',
      name:  'Workflow G',
      nodes: [
        { id: 'node-a', name: 'Source Node', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
        { id: 'node-b', name: 'Merge All Sources', type: 'n8n-nodes-base.merge', position: [240, 0], parameters: {} },
      ],
      connections: {
        'Source Node': {
          main: [[{ node: 'Merge All Sources', type: 'main', index: 0 }]],
        },
      },
      settings: {},
    });

    const result = await worker.invoke({
      workflowId: 'wf-7',
      nodeName:   'merge-all-001',
    });

    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.result as string);
    expect(parsed.node.id).toBe('node-b');
  });
});
