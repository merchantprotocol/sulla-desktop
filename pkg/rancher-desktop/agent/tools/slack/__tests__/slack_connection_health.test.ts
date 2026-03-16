import { afterEach, describe, expect, it, jest } from '@jest/globals';

const mockGet: any = jest.fn();
const mockInvalidate: any = jest.fn();
const mockInitializeService: any = jest.fn();
const mockGetConnectionStatus: any = jest.fn();
const mockGetIntegrationValue: any = jest.fn();
const mockSlackClientIsConnected: any = jest.fn();
const mockSlackClientInitialize: any = jest.fn();

jest.unstable_mockModule('../../../integrations', () => ({
  registry: {
    get:        mockGet,
    invalidate: mockInvalidate,
  },
}));

jest.unstable_mockModule('../../../integrations/slack/SlackClient', () => ({
  slackClient: {
    isConnected: mockSlackClientIsConnected,
    initialize:  mockSlackClientInitialize,
  },
}));

jest.unstable_mockModule('../../../services/IntegrationService', () => ({
  getIntegrationService: () => ({
    initialize:          mockInitializeService,
    getConnectionStatus: mockGetConnectionStatus,
    getIntegrationValue: mockGetIntegrationValue,
  }),
}));

async function loadSlackConnectionHealthTool() {
  return import('../slack_connection_health');
}

function configureWorker(worker: any, registration: any) {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('slack_connection_health tool', () => {
  afterEach(() => {
    mockGet.mockReset();
    mockInvalidate.mockReset();
    mockInitializeService.mockReset();
    mockGetConnectionStatus.mockReset();
    mockGetIntegrationValue.mockReset();
    mockSlackClientIsConnected.mockReset();
    mockSlackClientInitialize.mockReset();
  });

  it('returns healthy when client is present and auth.test succeeds', async() => {
    const { SlackConnectionHealthWorker, slackConnectionHealthRegistration } = await loadSlackConnectionHealthTool();

    mockInitializeService.mockResolvedValueOnce(undefined);
    mockGetConnectionStatus.mockResolvedValueOnce({ integration_id: 'slack', connected: true });
    mockGetIntegrationValue
      .mockResolvedValueOnce({ value: 'xoxb-test' })
      .mockResolvedValueOnce({ value: 'xapp-test' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockSlackClientIsConnected.mockReturnValue(true);

    mockGet.mockResolvedValueOnce({
      apiCall: jest.fn(async(method: string) => {
        if (method === 'auth.test') {
          return { ok: true };
        }
        if (method === 'users.list') {
          return { ok: true, members: [{ id: 'U123' }] };
        }
        return { ok: true };
      }),
    });

    const worker = configureWorker(new SlackConnectionHealthWorker(), slackConnectionHealthRegistration);
    const result = await worker.invoke({});

    expect(result.success).toBe(true);
    expect(result.result).toContain('"healthy": true');
    expect(result.result).toContain('"dataPullOk": true');
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('reinitializes when registry client is null and succeeds after retry', async() => {
    const { SlackConnectionHealthWorker, slackConnectionHealthRegistration } = await loadSlackConnectionHealthTool();

    mockInitializeService.mockResolvedValueOnce(undefined);
    mockGetConnectionStatus.mockResolvedValueOnce({ integration_id: 'slack', connected: true });
    mockGetIntegrationValue
      .mockResolvedValueOnce({ value: 'xoxb-test' })
      .mockResolvedValueOnce({ value: 'xapp-test' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockSlackClientIsConnected.mockReturnValue(false).mockReturnValue(true);

    mockGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        apiCall: jest.fn(async(method: string) => {
          if (method === 'users.list') {
            return { ok: true, members: [{ id: 'U456' }] };
          }
          return { ok: true };
        }),
      });

    const worker = configureWorker(new SlackConnectionHealthWorker(), slackConnectionHealthRegistration);
    const result = await worker.invoke({ reinitializeIfNeeded: true });

    expect(result.success).toBe(true);
    expect(result.result).toContain('"reinitialized": true');
    expect(result.result).toContain('"dataPullOk": true');
    expect(mockInvalidate).toHaveBeenCalledWith('slack');
  });

  it('returns failure when auth is bad and reinitialize disabled', async() => {
    const { SlackConnectionHealthWorker, slackConnectionHealthRegistration } = await loadSlackConnectionHealthTool();

    mockInitializeService.mockResolvedValueOnce(undefined);
    mockGetConnectionStatus.mockResolvedValueOnce({ integration_id: 'slack', connected: true });
    mockGetIntegrationValue
      .mockResolvedValueOnce({ value: 'xoxb-test' })
      .mockResolvedValueOnce({ value: 'xapp-test' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockSlackClientIsConnected.mockReturnValue(true);

    mockGet.mockResolvedValueOnce({
      apiCall: jest.fn(async() => ({ ok: false, error: 'invalid_auth' })),
    });

    const worker = configureWorker(new SlackConnectionHealthWorker(), slackConnectionHealthRegistration);
    const result = await worker.invoke({ reinitializeIfNeeded: false });

    expect(result.success).toBe(false);
    expect(result.result).toContain('"authOk": false');
    expect(result.result).toContain('invalid_auth');
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
