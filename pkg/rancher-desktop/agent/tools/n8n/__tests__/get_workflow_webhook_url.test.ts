import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockGetWorkflow: any = jest.fn();
const mockInitialize: any = jest.fn();
const mockQuery: any = jest.fn();

jest.unstable_mockModule('../../../services/N8nService', () => ({
  createN8nService: jest.fn(async() => ({
    getWorkflow: mockGetWorkflow,
  })),
}));

jest.unstable_mockModule('../../../database/PostgresClient', () => ({
  postgresClient: {
    initialize: mockInitialize,
    query:      mockQuery,
  },
}));

async function loadTool() {
  return import('../get_workflow_webhook_url');
}

describe('get_workflow_webhook_url tool', () => {
  afterEach(() => {
    mockGetWorkflow.mockReset();
    mockInitialize.mockReset();
    mockQuery.mockReset();
  });

  it('returns webhook URLs and registration status for webhook nodes', async() => {
    const { GetWorkflowWebhookUrlWorker } = await loadTool();

    mockGetWorkflow.mockResolvedValueOnce({
      id:    'V1VkT6m5PNBTNATH',
      name:  'GitHub API Test - Auto-configured Credential',
      nodes: [
        {
          id:         'webhook-1',
          name:       'WebhookTrigger',
          type:       'n8n-nodes-base.webhook',
          parameters: {
            httpMethod: 'POST',
            path:       'test-github-auto-cred',
          },
        },
      ],
    });

    mockInitialize.mockResolvedValueOnce(undefined);
    mockQuery.mockResolvedValueOnce([
      {
        webhookPath: 'V1VkT6m5PNBTNATH/webhooktrigger/test-github-auto-cred',
        method:      'POST',
        workflowId:  'V1VkT6m5PNBTNATH',
      },
    ]);

    const worker = new GetWorkflowWebhookUrlWorker();
    worker.name = 'get_workflow_webhook_url';
    worker.description = 'Get workflow webhook URLs';
    worker.schemaDef = {
      workflowId: { type: 'string', optional: true },
      id:         { type: 'string', optional: true },
    } as any;

    const result = await worker.invoke({ workflowId: 'V1VkT6m5PNBTNATH' });

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.result as string);

    expect(payload.workflowId).toBe('V1VkT6m5PNBTNATH');
    expect(payload.webhooks).toHaveLength(1);
    expect(payload.webhooks[0].expectedPath).toBe('V1VkT6m5PNBTNATH/webhooktrigger/test-github-auto-cred');
    expect(payload.webhooks[0].fullUrl).toBe('http://127.0.0.1:30119/webhook/V1VkT6m5PNBTNATH/webhooktrigger/test-github-auto-cred');
    expect(payload.webhooks[0].registeredInDatabase).toBe(true);
    expect(payload.webhookWarning).toBeNull();
  });

  it('includes webhookWarning when any webhook is unregistered', async() => {
    const { GetWorkflowWebhookUrlWorker } = await loadTool();

    mockGetWorkflow.mockResolvedValueOnce({
      id:    'wf-2',
      name:  'Workflow 2',
      nodes: [
        {
          id:         'webhook-1',
          name:       'Webhook Trigger',
          type:       'n8n-nodes-base.webhook',
          parameters: {
            httpMethod: 'POST',
            path:       'start',
          },
        },
      ],
    });

    mockInitialize.mockResolvedValueOnce(undefined);
    mockQuery.mockResolvedValueOnce([]);

    const worker = new GetWorkflowWebhookUrlWorker();
    worker.name = 'get_workflow_webhook_url';
    worker.description = 'Get workflow webhook URLs';
    worker.schemaDef = {
      workflowId: { type: 'string', optional: true },
      id:         { type: 'string', optional: true },
    } as any;

    const result = await worker.invoke({ id: 'wf-2' });

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.result as string);

    expect(payload.webhooks[0].registeredInDatabase).toBe(false);
    expect(payload.webhooks[0].expectedPath).toBe('wf-2/webhook-trigger/start');
    expect(payload.webhooks[0].namingIssue).toBeDefined();
    expect(payload.webhookWarning).toBeTruthy();
    expect(payload.webhookWarning.critical).toBe(true);
    expect(payload.webhookWarning.action).toContain('docker restart sulla_n8n');
  });
});
